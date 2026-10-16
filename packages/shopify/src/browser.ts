import { lookup } from 'node:dns/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AdminEvidenceReport } from '../../shared/src/admin-evidence.js';
import type { AjaxNormalizedProduct } from '../../shared/src/ajax-evidence.js';
import {
  browserEvidenceSchema,
  type BrowserEvidence,
  type BrowserReasonCode,
} from '../../shared/src/browser-evidence.js';
import { deriveHtmlProductTarget, isPublicNetworkAddress } from './ajax.js';

const NAVIGATION_MS = 15_000;
const ACTION_MS = 5_000;

function inconclusive(variantId: string, legacyId: string, reasonCode: BrowserReasonCode) {
  return {
    requestedVariantId: variantId, requestedLegacyVariantId: legacyId,
    outcome: 'inconclusive' as const, reasonCode, selectedLegacyVariantId: null,
    controlState: 'missing' as const, cartOutcome: 'not_attempted' as const,
    storefrontPurchasable: null, controlVisible: false, controlEnabled: null,
    controlDisabled: null, ariaDisabled: null, controlLabel: null,
  };
}

async function cartProbe(page: Page, form: ReturnType<Page['locator']>, legacyId: string): Promise<{
  outcome: 'succeeded' | 'rejected' | 'inconclusive'; reason?: BrowserReasonCode;
}> {
  const quantity = form.locator('input[name="quantity"]');
  if (await quantity.count() > 1 || await quantity.count() === 1 && await quantity.inputValue() !== '1') {
    return { outcome: 'inconclusive', reason: 'unsupported_cart_probe' };
  }
  const origin = new URL(page.url()).origin;
  const cartUrl = new URL('./cart.js', `${origin}/`).href;
  const clearUrl = new URL('./cart/clear.js', `${origin}/`).href;
  const cart = await page.context().request.get(cartUrl, { timeout: ACTION_MS });
  const before = await cart.json().catch(() => null) as { items?: unknown[] } | null;
  if (!cart.ok() || !before || !Array.isArray(before.items) || before.items.length !== 0) {
    return { outcome: 'inconclusive', reason: 'cart_not_empty' };
  }
  let result: { outcome: 'succeeded' | 'rejected' | 'inconclusive'; reason?: BrowserReasonCode } = {
    outcome: 'inconclusive', reason: 'cart_verification_failed',
  };
  try {
    const responsePromise = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === origin && /^\/cart\/add(?:\.js)?$/.test(url.pathname);
    }, { timeout: ACTION_MS });
    await form.locator('button[name="add"], button[type="submit"]:not([name="checkout"])').click({
      timeout: ACTION_MS,
      noWaitAfter: true,
    });
    const response = await responsePromise;
    const body = await response.json().catch(() => null) as { variant_id?: number | string; id?: number | string; quantity?: number } | null;
    const returnedId = body?.variant_id ?? body?.id;
    if (!response.ok()) result = { outcome: 'rejected' };
    else if (String(returnedId) !== legacyId || !body || Number(body.quantity) <= 0) {
      result = { outcome: 'inconclusive', reason: 'cart_response_mismatch' };
    } else {
      const verified = await page.context().request.get(cartUrl, { timeout: ACTION_MS });
      const data = await verified.json().catch(() => null) as { items?: Array<{ variant_id?: number | string; quantity?: number }> } | null;
      result = verified.ok() && data?.items?.some(item => String(item.variant_id) === legacyId && Number(item.quantity) > 0)
        ? { outcome: 'succeeded' } : { outcome: 'inconclusive', reason: 'cart_verification_failed' };
    }
  } catch {
    result = { outcome: 'inconclusive', reason: 'cart_verification_failed' };
  } finally {
    try {
      const cleared = await page.context().request.post(clearUrl, { timeout: ACTION_MS });
      const verify = await page.context().request.get(cartUrl, { timeout: ACTION_MS });
      const body = await verify.json().catch(() => null) as { items?: unknown[] } | null;
      if (!cleared.ok() || !verify.ok() || !body || !Array.isArray(body.items) || body.items.length !== 0) {
        result = { outcome: 'inconclusive', reason: 'cart_cleanup_failed' };
      }
    } catch {
      result = { outcome: 'inconclusive', reason: 'cart_cleanup_failed' };
    }
  }
  return result;
}

async function selectExactVariant(
  form: ReturnType<Page['locator']>,
  variant: AdminEvidenceReport['product']['variants'][number],
): Promise<boolean> {
  const ids = form.locator('input[name="id"]');
  if (await ids.count() !== 1) return false;
  if (await ids.inputValue() === variant.legacyResourceId) return true;
  for (const option of variant.selectedOptions) {
    const select = form.getByLabel(option.name, { exact: true });
    if (await select.count() === 1 && await select.evaluate(element => element.tagName === 'SELECT')) {
      await select.selectOption({ label: option.value }, { timeout: ACTION_MS }).catch(() => undefined);
      continue;
    }
    const choice = form.getByLabel(option.value, { exact: true });
    if (await choice.count() !== 1) return false;
    await choice.check({ timeout: ACTION_MS }).catch(async () => {
      await choice.click({ timeout: ACTION_MS });
    }).catch(() => undefined);
  }
  await ids.waitFor({ state: 'attached', timeout: ACTION_MS }).catch(() => undefined);
  return await ids.inputValue().catch(() => '') === variant.legacyResourceId;
}

export async function observeDawnVariant(
  context: BrowserContext,
  baseUrl: URL,
  variant: AdminEvidenceReport['product']['variants'][number],
  ajaxVariant: AjaxNormalizedProduct['variants'][number],
  cartAuthorized: boolean,
) {
  if (cartAuthorized && (ajaxVariant.requiresSellingPlan === true || ajaxVariant.sellingPlanAllocations.length > 0)) {
    return inconclusive(variant.id, variant.legacyResourceId, 'unsupported_cart_probe');
  }
  const page = await context.newPage();
  page.on('popup', popup => void popup.close());
  const target = new URL(baseUrl.href);
  target.searchParams.set('variant', variant.legacyResourceId);
  try {
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_MS });
    if (!response) return inconclusive(variant.id, variant.legacyResourceId, 'navigation_failed');
    if ([401, 403].includes(response.status())) return inconclusive(variant.id, variant.legacyResourceId, 'http_unauthorized');
    if (response.status() === 404) return inconclusive(variant.id, variant.legacyResourceId, 'http_not_found');
    if ([429, 430].includes(response.status())) return inconclusive(variant.id, variant.legacyResourceId, 'rate_limited');
    if (response.status() < 200 || response.status() >= 300) return inconclusive(variant.id, variant.legacyResourceId, 'http_status');
    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== baseUrl.origin) return inconclusive(variant.id, variant.legacyResourceId, 'redirect_observed');
    if (finalUrl.pathname.replace(/\/$/, '') !== baseUrl.pathname.replace(/\/$/, '')) {
      return inconclusive(variant.id, variant.legacyResourceId, 'product_identity_mismatch');
    }
    if (await page.locator('input[type="password"], iframe[src*="captcha" i], [class*="captcha" i]').count() > 0) {
      return inconclusive(variant.id, variant.legacyResourceId, 'password_or_challenge');
    }
    const candidates = page.locator('form[action]');
    const visible = [];
    for (const candidate of await candidates.all()) {
      const action = await candidate.getAttribute('action');
      if (action === null) continue;
      const actionUrl = new URL(action, page.url());
      if (actionUrl.origin === baseUrl.origin && /^\/cart\/add(?:\.js)?$/.test(actionUrl.pathname) && await candidate.isVisible()) {
        visible.push(candidate);
      }
    }
    if (visible.length === 0) return inconclusive(variant.id, variant.legacyResourceId, 'missing_product_form');
    if (visible.length !== 1) return inconclusive(variant.id, variant.legacyResourceId, 'ambiguous_product_form');
    const form = visible[0]!;
    if (!await selectExactVariant(form, variant)) return inconclusive(variant.id, variant.legacyResourceId, 'selection_failed');
    const selected = await form.getAttribute('data-selected-variant');
    if (selected !== null && selected !== variant.legacyResourceId) {
      return inconclusive(variant.id, variant.legacyResourceId, 'variant_identity_mismatch');
    }
    const buttons = form.locator('button[name="add"], button[type="submit"]:not([name="checkout"])');
    const visibleButtons = [];
    for (const button of await buttons.all()) {
      if (await button.isVisible()) visibleButtons.push(button);
    }
    if (visibleButtons.length === 0) return inconclusive(variant.id, variant.legacyResourceId, 'missing_add_control');
    if (visibleButtons.length !== 1) return inconclusive(variant.id, variant.legacyResourceId, 'ambiguous_add_control');
    const button = visibleButtons[0]!;
    const disabled = await button.isDisabled();
    const ariaDisabled = (await button.getAttribute('aria-disabled')) === 'true';
    const controlLabel = (await button.innerText()).trim().slice(0, 120) || null;
    if (!disabled && !ariaDisabled) {
      try { await button.click({ trial: true, timeout: ACTION_MS }); }
      catch { return inconclusive(variant.id, variant.legacyResourceId, 'obscured_add_control'); }
    }
    const cart = cartAuthorized && !disabled && !ariaDisabled
      ? await cartProbe(page, form, variant.legacyResourceId) : { outcome: 'not_attempted' as const };
    if ('reason' in cart && cart.reason) return inconclusive(variant.id, variant.legacyResourceId, cart.reason);
    const storefrontPurchasable = cartAuthorized
      ? cart.outcome === 'succeeded'
      : !(disabled || ariaDisabled);
    return {
      requestedVariantId: variant.id, requestedLegacyVariantId: variant.legacyResourceId,
      outcome: 'observed' as const, reasonCode: null, selectedLegacyVariantId: variant.legacyResourceId,
      controlState: disabled || ariaDisabled ? 'disabled' as const : 'enabled' as const,
      cartOutcome: cart.outcome, storefrontPurchasable,
      controlVisible: true, controlEnabled: !(disabled || ariaDisabled), controlDisabled: disabled,
      ariaDisabled, controlLabel,
    };
  } catch (error) {
    return inconclusive(variant.id, variant.legacyResourceId,
      error instanceof Error && /timeout/i.test(error.message) ? 'timeout' : 'navigation_failed');
  } finally { await page.close().catch(() => undefined); }
}

export async function collectBrowserEvidence(
  admin: AdminEvidenceReport,
  ajax: AjaxNormalizedProduct,
  cartAuthorized: boolean,
  now: () => Date = () => new Date(),
): Promise<BrowserEvidence> {
  const startedAt = now().toISOString();
  if (admin.product.onlineStoreUrl === null) return browserEvidenceSchema.parse({
    schemaVersion: 1, source: 'browser', outcome: 'inconclusive', reasonCode: 'not_published_to_online_store',
    observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations: [],
    limitations: ['Fresh isolated Chromium contexts; Dawn-compatible product forms only.'],
  });
  if (admin.product.variants.length === 0) return browserEvidenceSchema.parse({
    schemaVersion: 1, source: 'browser', outcome: 'inconclusive', reasonCode: 'browser_prerequisite_unavailable',
    observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations: [],
    limitations: ['Dawn-compatible product forms only.'],
  });
  let target;
  try { target = deriveHtmlProductTarget(admin.product.onlineStoreUrl); }
  catch { return browserEvidenceSchema.parse({ schemaVersion: 1, source: 'browser', outcome: 'inconclusive', reasonCode: 'invalid_online_store_url', observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations: [], limitations: ['Dawn-compatible product forms only.'] }); }
  const addresses = await lookup(target.url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) return browserEvidenceSchema.parse({ schemaVersion: 1, source: 'browser', outcome: 'inconclusive', reasonCode: 'dns_resolution_failed', observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations: [], limitations: ['Dawn-compatible product forms only.'] });
  if (addresses.some(value => !isPublicNetworkAddress(value.address))) return browserEvidenceSchema.parse({ schemaVersion: 1, source: 'browser', outcome: 'inconclusive', reasonCode: 'unsafe_network_address', observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations: [], limitations: ['Dawn-compatible product forms only.'] });
  const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${target.url.hostname} ${addresses[0]!.address}`] }).catch(() => null);
  if (!browser) return browserEvidenceSchema.parse({ schemaVersion: 1, source: 'browser', outcome: 'inconclusive', reasonCode: 'browser_unavailable', observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations: [], limitations: ['Dawn-compatible product forms only.'] });
  const observations = [];
  try {
    for (const variant of admin.product.variants) {
      const ajaxVariant = ajax.variants.find(value => value.id === variant.legacyResourceId);
      if (!ajaxVariant) { observations.push(inconclusive(variant.id, variant.legacyResourceId, 'variant_identity_mismatch')); continue; }
      const context = await browser.newContext({ serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      await context.routeWebSocket('**', socket => socket.close());
      await context.route('**/*', async route => {
        let url: URL;
        try { url = new URL(route.request().url()); }
        catch { await route.abort(); return; }
        if (url.origin !== target.url.origin || /\/(checkout|account|orders?|payments?)(?:\/|$)/i.test(url.pathname)) return route.abort();
        const headers = { ...route.request().headers() };
        delete headers.authorization; delete headers['x-shopify-access-token'];
        await route.continue({ headers });
      });
      observations.push(await observeDawnVariant(context, target.url, variant, ajaxVariant, cartAuthorized));
      await context.close();
    }
  } finally { await browser.close(); }
  return browserEvidenceSchema.parse({
    schemaVersion: 1, source: 'browser',
    outcome: observations.every(value => value.outcome === 'observed') ? 'observed' : 'inconclusive',
    reasonCode: observations.find(value => value.reasonCode !== null)?.reasonCode ?? null,
    observationWindow: { startedAt, completedAt: now().toISOString() }, cartAuthorized, observations,
    limitations: ['Dawn-compatible forms only; one fresh nonpersistent context per variant.', 'No checkout, account, payment, screenshot, trace, video, or persistent browser state.'],
  });
}
