import { isIP } from 'node:net';
import type { BrowserContext } from 'playwright';
import { normalizeShop } from '../../shared/src/shop.js';
import type { AdminEvidenceReport } from '../../shared/src/admin-evidence.js';
import {
  defaultAjaxTransportDependencies, isPublicNetworkAddress, waitForObservation,
  deriveHtmlProductTarget, type AjaxTransportDependencies,
} from './ajax.js';
import { extractStorefrontPasswordForm } from './html-evidence.js';

/** Run-scoped, host-only authentication. Never serialize or persist this object. */
export type StorefrontSession = {
  origin: string;
  cookies: Array<{ name: string; value: string }>;
};

export class StorefrontAuthenticationError extends Error {
  constructor() {
    super('Storefront sign-in failed. Check the storefront password in Connection. Challenges and redirects to other hosts are not supported.');
  }
}

export function validateStorefrontPassword(password: string): void {
  if (!password || password.length > 1024 || /[\0\r\n]/.test(password)) {
    throw new Error('Enter a storefront password of 1 to 1024 characters without control characters.');
  }
}

export function storefrontCookieHeader(session: StorefrontSession, target: URL): string {
  if (target.protocol !== 'https:' || target.origin !== session.origin || target.username || target.password) {
    throw new StorefrontAuthenticationError();
  }
  if (!session.cookies.length || session.cookies.some(cookie =>
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || !/^[\x21-\x3A\x3C-\x7E]+$/.test(cookie.value))) {
    throw new StorefrontAuthenticationError();
  }
  return session.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

export async function seedStorefrontSession(context: BrowserContext, target: URL, session: StorefrontSession): Promise<void> {
  storefrontCookieHeader(session, target);
  await context.addCookies(session.cookies.map(cookie => ({
    ...cookie, url: session.origin, secure: true, httpOnly: true, sameSite: 'Lax' as const,
  })));
}

function authCookies(headers: string[], hostname: string): StorefrontSession['cookies'] {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    if (header.length > 8192) continue;
    const [pair = '', ...attributes] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const attrs = new Map(attributes.map(attribute => {
      const [key = '', ...parts] = attribute.trim().split('=');
      return [key.toLowerCase(), parts.join('=')];
    }));
    // Promote only root-scoped cookies from the exact sign-in host, never parent domains.
    if (attrs.has('domain') && attrs.get('domain')!.replace(/^\./, '').toLowerCase() !== hostname) continue;
    if (attrs.has('path') && attrs.get('path') !== '/') continue;
    if ((attrs.has('max-age') && Number(attrs.get('max-age')) <= 0) ||
        (attrs.has('expires') && Date.parse(attrs.get('expires')!) <= Date.now()) || !value) {
      cookies.delete(name); continue;
    }
    if (value) cookies.set(name, value);
  }
  return [...cookies].map(([name, value]) => ({ name, value })).slice(0, 30);
}

/** The only authenticated POST is Shopify's documented storefront_password form. */
export async function authenticateStorefront(
  shopInput: string,
  password: string,
  dependencies: AjaxTransportDependencies = defaultAjaxTransportDependencies,
): Promise<StorefrontSession> {
  validateStorefrontPassword(password);
  const shop = normalizeShop(shopInput);
  const url = new URL(`https://${shop}/password`);
  const signal = AbortSignal.timeout(dependencies.observationTimeoutMs ?? 15_000);
  const now = dependencies.now ?? Date.now;
  const deadline = now() + (dependencies.observationTimeoutMs ?? 15_000);
  try {
    const addresses = await waitForObservation(dependencies.resolve(shop, signal), signal);
    if (!addresses.length || addresses.some(address => isIP(address.address) !== address.family || !isPublicNetworkAddress(address.address))) {
      throw new StorefrontAuthenticationError();
    }
    const target = { url, handle: '', localePath: null };
    const page = await waitForObservation(dependencies.request(target, addresses[0]!, {
      signal, timeoutMs: deadline - now(),
    }), signal);
    if (!page.ok || page.response.status !== 200 || page.response.body.length > 5 * 1024 * 1024 ||
        !/^text\/html(?:;|$)/i.test(page.response.contentType ?? '')) throw new StorefrontAuthenticationError();
    const form = extractStorefrontPasswordForm(new TextDecoder('utf-8', { fatal: true }).decode(page.response.body), url.origin);
    if (!form) throw new StorefrontAuthenticationError();
    const initialCookies = authCookies(page.response.setCookies ?? [], shop);
    const cookie = initialCookies.length ? storefrontCookieHeader({ origin: url.origin, cookies: initialCookies }, url) : undefined;
    const fields = new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password });
    if (form.authenticityToken) fields.set('authenticity_token', form.authenticityToken);
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0) throw new StorefrontAuthenticationError();
    const result = await waitForObservation(dependencies.request(
      target, addresses[0]!, {
        signal, timeoutMs, ...(cookie ? { cookie } : {}), formBody: fields.toString(),
      },
    ), signal);
    if (!result.ok || ![302, 303].includes(result.response.status) || !result.response.location) {
      throw new StorefrontAuthenticationError();
    }
    const destination = new URL(result.response.location, url);
    if (destination.origin !== url.origin || destination.username || destination.password || destination.pathname !== '/') {
      throw new StorefrontAuthenticationError();
    }
    // A successful redirect must issue a session cookie, not just echo the CSRF cookie.
    if (!authCookies(result.response.setCookies ?? [], shop).length) throw new StorefrontAuthenticationError();
    const session = { origin: url.origin, cookies: authCookies([
      ...(page.response.setCookies ?? []), ...(result.response.setCookies ?? []),
    ], shop) };
    storefrontCookieHeader(session, url);
    return session;
  } catch {
    // Never reflect response bodies, headers, cookies, passwords or transport errors.
    throw new StorefrontAuthenticationError();
  }
}

/** Null onlineStoreUrl alone cannot distinguish unpublished from password-protected. */
export function protectedProductUrl(shopInput: string, admin: AdminEvidenceReport): string | null {
  const shop = normalizeShop(shopInput);
  if (admin.product.status !== 'ACTIVE' || !admin.product.publishedAt || !admin.product.handle ||
      !/^[a-z0-9][a-z0-9-]*$/.test(admin.product.handle)) return null;
  return deriveHtmlProductTarget(`https://${shop}/products/${admin.product.handle}`).url.href;
}
