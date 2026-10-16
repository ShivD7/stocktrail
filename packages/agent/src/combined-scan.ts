import { randomUUID } from 'node:crypto';
import { readConfig, type Config } from './config.js';
import { readStoredToken } from './auth.js';
import { validateAdminScanTarget } from './admin-scan.js';
import { ShopifyAdminClient } from '../../shopify/src/admin-client.js';
import { readAdminProductEvidence } from '../../shopify/src/admin-evidence.js';
import {
  decodeHtmlBody,
  deriveAjaxProductTarget,
  deriveHtmlProductTarget,
  fetchAjaxProduct,
  fetchHtmlProduct,
  normalizeAjaxProduct,
  type AjaxFetchResult,
  type DerivedAjaxTarget,
} from '../../shopify/src/ajax.js';
import { extractHtmlEvidence, normalizeJsonLd } from '../../shopify/src/html-evidence.js';
import { assertShopifyProductGid, type AdminEvidenceReport } from '../../shared/src/admin-evidence.js';
import type { AjaxNormalizedProduct } from '../../shared/src/ajax-evidence.js';
import {
  productEvidenceBundleSchema,
  type BundleArtifact,
  type BundleReasonCode,
  type ProductEvidenceBundle,
} from '../../shared/src/evidence-bundle.js';
import {
  describeBundleArtifact,
  removeBundleRun,
  writeBundleRun,
  type BundleArtifactInput,
} from './bundle-storage.js';
import { openCatalogRepository } from '../../database/src/catalog-repository.js';
import { collectBrowserEvidence } from '../../shopify/src/browser.js';
import type { BrowserEvidence } from '../../shared/src/browser-evidence.js';
import { evaluateVariantDiagnostics } from '../../detector/src/diagnostic.js';
import {
  scoreInventorySearchReadiness,
  type AdminContentEvidence,
} from '../../scorer/src/readiness.js';
import { persistDiagnosticResults } from './diagnostic-results.js';
import type { RuleEvaluation } from '../../shared/src/diagnostics.js';
import type { ReadinessScore } from '../../shared/src/readiness.js';

export type CombinedScanResult = { bundle: ProductEvidenceBundle; evaluations?: RuleEvaluation[]; readinessTotal?: number | null };
export type CombinedScanOptions = { browser?: boolean; cartAdd?: boolean };

export type CombinedScanDependencies = {
  readConfig(directory: string): Promise<Config>;
  validateTarget(directory: string, shop: string, productId: string): Promise<void>;
  readToken(shop: string): Promise<string>;
  readAdmin(shop: string, token: string, productId: string): Promise<AdminEvidenceReport>;
  fetchAjax(target: DerivedAjaxTarget): Promise<AjaxFetchResult>;
  fetchHtml(target: DerivedAjaxTarget): Promise<AjaxFetchResult>;
  collectBrowser(admin: AdminEvidenceReport, ajax: AjaxNormalizedProduct, cartAuthorized: boolean): Promise<BrowserEvidence>;
  persistDiagnostics(
    directory: string,
    shop: string,
    productId: string,
    input: { evidenceRunId: string; evaluatedAt: string; evaluations: RuleEvaluation[]; readiness: ReadinessScore },
  ): Promise<unknown>;
  saveBundle(
    directory: string,
    shop: string,
    productId: string,
    runId: string,
    inputs: BundleArtifactInput[],
    bundle: ProductEvidenceBundle,
  ): Promise<ProductEvidenceBundle>;
  now(): Date;
  uuid(): string;
};

export async function saveEvidenceBundle(
  directory: string,
  shop: string,
  productId: string,
  runId: string,
  inputs: BundleArtifactInput[],
  bundle: ProductEvidenceBundle,
): Promise<ProductEvidenceBundle> {
  const written = await writeBundleRun(directory, runId, inputs, bundle);
  try {
    const repository = await openCatalogRepository(directory);
    try {
      const sources = Object.entries(written.bundle.sources).map(([source, value]) => ({
        source: source as 'admin' | 'ajax' | 'html' | 'jsonld' | 'browser',
        outcome: value.outcome,
        reasonCode: value.reasonCode,
        status: value.status,
        contentType: value.contentType,
        itemCount: value.itemCount,
      }));
      repository.recordEvidenceRun(shop, productId, {
        runId,
        status: written.bundle.collectionStatus,
        startedAt: written.bundle.observationWindow.startedAt,
        completedAt: written.bundle.observationWindow.completedAt,
        sources,
        artifacts: written.indexedArtifacts,
      });
    } finally {
      repository.close();
    }
    return written.bundle;
  } catch {
    await removeBundleRun(written.finalDirectory).catch(() => undefined);
    throw new Error('Could not save the evidence bundle securely. No evidence bundle was saved.');
  }
}

const defaultDependencies: CombinedScanDependencies = {
  readConfig,
  validateTarget: validateAdminScanTarget,
  readToken: readStoredToken,
  async readAdmin(shop, token, productId) {
    return readAdminProductEvidence(new ShopifyAdminClient(shop, token), productId);
  },
  fetchAjax: fetchAjaxProduct,
  fetchHtml: fetchHtmlProduct,
  collectBrowser: collectBrowserEvidence,
  persistDiagnostics: persistDiagnosticResults,
  saveBundle: saveEvidenceBundle,
  now: () => new Date(),
  uuid: randomUUID,
};

function reason(value: string | null): BundleReasonCode | null {
  return value as BundleReasonCode | null;
}

function matchAjax(
  productId: string,
  handle: string,
  admin: AdminEvidenceReport,
  product: AjaxNormalizedProduct,
): { reasonCode: BundleReasonCode | null; matched: number } {
  if (product.id !== productId.slice(productId.lastIndexOf('/') + 1)) return { reasonCode: 'product_id_mismatch', matched: 0 };
  if (product.handle !== handle) return { reasonCode: 'handle_mismatch', matched: 0 };
  if (admin.product.variants.length > 250 || product.variants.length > 250) {
    return { reasonCode: 'variant_limit_exceeded', matched: 0 };
  }
  const adminIds = new Set<string>();
  for (const variant of admin.product.variants) {
    if (adminIds.has(variant.legacyResourceId)) return { reasonCode: 'duplicate_admin_legacy_id', matched: 0 };
    adminIds.add(variant.legacyResourceId);
  }
  const ajaxIds = new Set(product.variants.map(variant => variant.id));
  let matched = 0;
  for (const id of ajaxIds) {
    if (!adminIds.has(id)) return { reasonCode: 'unexpected_ajax_variant', matched };
    matched += 1;
  }
  for (const id of adminIds) if (!ajaxIds.has(id)) return { reasonCode: 'missing_ajax_variant', matched };
  return { reasonCode: null, matched };
}

function refsFor(source: 'admin' | 'ajax' | 'html' | 'jsonld' | 'browser', artifacts: BundleArtifact[]): BundleArtifact[] {
  return artifacts.filter(artifact => artifact.source === source);
}

const ADMIN_TITLE_LIMIT = 1_000;
const ADMIN_DESCRIPTION_LIMIT = 1_000_000;
const ADMIN_SEO_LIMIT = 10_000;

function normalizedAdminText(
  value: unknown,
  maximum: number,
  allowEmpty: boolean,
): string | null {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) return null;
  const normalized = value.trim();
  return allowEmpty || normalized.length > 0 ? normalized : null;
}

export function adminContentForReadiness(admin: AdminEvidenceReport): AdminContentEvidence | null {
  const title = normalizedAdminText(admin.product.title, ADMIN_TITLE_LIMIT, false);
  const descriptionHtml = normalizedAdminText(admin.product.descriptionHtml, ADMIN_DESCRIPTION_LIMIT, true);
  const seo = admin.product.seo;
  if (title === null || descriptionHtml === null || seo === undefined || admin.product.variants.length === 0) {
    return null;
  }
  const seoTitle = seo.title === null ? null : normalizedAdminText(seo.title, ADMIN_SEO_LIMIT, true);
  const seoDescription = seo.description === null
    ? null : normalizedAdminText(seo.description, ADMIN_SEO_LIMIT, true);
  if ((seo.title !== null && seoTitle === null) || (seo.description !== null && seoDescription === null)) {
    return null;
  }
  const productTime = Date.parse(admin.product.updatedAt);
  if (!Number.isFinite(productTime)) return null;
  let latestInventoryUpdatedAt: string | null = null;
  let latestInventoryTime = Number.NEGATIVE_INFINITY;
  for (const variant of admin.product.variants) {
    const timestamp = variant.inventoryItem.updatedAt;
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) return null;
    if (time > latestInventoryTime) {
      latestInventoryTime = time;
      latestInventoryUpdatedAt = timestamp;
    }
  }
  if (latestInventoryUpdatedAt === null) return null;
  return {
    title,
    descriptionHtml,
    seoTitle,
    seoDescription,
    productUpdatedAt: admin.product.updatedAt,
    latestInventoryUpdatedAt,
  };
}

export async function scanEvidenceBundle(
  directory: string,
  productId: string,
  dependencies: CombinedScanDependencies = defaultDependencies,
  options: CombinedScanOptions = {},
): Promise<CombinedScanResult> {
  assertShopifyProductGid(productId);
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  await dependencies.validateTarget(directory, config.shop, productId);
  const token = await dependencies.readToken(config.shop);
  const startedAt = dependencies.now().toISOString();
  const admin = await dependencies.readAdmin(config.shop, token, productId);
  const runId = dependencies.uuid();
  const inputs: BundleArtifactInput[] = [{
    source: 'admin', relativePath: 'admin.json', mediaType: 'application/json',
    contents: JSON.stringify(admin, null, 2) + '\n',
  }];

  let ajaxFetch: AjaxFetchResult | null = null;
  let htmlFetch: AjaxFetchResult | null = null;
  let ajaxReason: BundleReasonCode | null = null;
  let htmlReason: BundleReasonCode | null = null;
  let jsonLdReason: BundleReasonCode | null = null;
  let ajaxVariantCount = 0;
  let ajaxMatched = 0;
  let ajaxProduct: AjaxNormalizedProduct | null = null;
  let htmlText: string | null = null;
  let canonicalPresent = false;
  let jsonLdPresence: 'present' | 'absent' | 'unknown' = 'unknown';
  let jsonLdBlocks = 0;
  let validJsonLdBlocks = 0;
  let claims: ProductEvidenceBundle['sources']['jsonld']['claims'] = [];

  if (admin.product.onlineStoreUrl === null) {
    ajaxReason = htmlReason = jsonLdReason = 'not_published_to_online_store';
  } else {
    let ajaxTarget: DerivedAjaxTarget | null = null;
    let htmlTarget: DerivedAjaxTarget | null = null;
    try {
      ajaxTarget = deriveAjaxProductTarget(admin.product.onlineStoreUrl);
      htmlTarget = deriveHtmlProductTarget(admin.product.onlineStoreUrl);
    } catch {
      ajaxReason = htmlReason = jsonLdReason = 'invalid_online_store_url';
    }
    if (ajaxTarget !== null && htmlTarget !== null) {
      [ajaxFetch, htmlFetch] = await Promise.all([
        dependencies.fetchAjax(ajaxTarget), dependencies.fetchHtml(htmlTarget),
      ]);
      if (ajaxFetch.reasonCode !== null || ajaxFetch.body === null) {
        ajaxReason = reason(ajaxFetch.reasonCode ?? 'transport_failure');
      } else {
        let ajaxText: string | null = null;
        try { ajaxText = new TextDecoder('utf-8', { fatal: true }).decode(ajaxFetch.body); } catch { ajaxReason = 'body_decode_failed'; }
        if (ajaxText !== null) {
          inputs.push({ source: 'ajax', relativePath: 'ajax.json', mediaType: 'application/json', contents: ajaxText });
          const normalized = normalizeAjaxProduct(ajaxFetch.body);
          if (!normalized.ok) ajaxReason = reason(normalized.reasonCode);
          else {
            ajaxProduct = normalized.product;
            ajaxVariantCount = normalized.product.variants.length;
            const match = matchAjax(productId, ajaxTarget.handle, admin, normalized.product);
            ajaxReason = match.reasonCode;
            ajaxMatched = match.matched;
          }
        }
      }

      if (htmlFetch.reasonCode !== null || htmlFetch.body === null) {
        htmlReason = reason(htmlFetch.reasonCode ?? 'transport_failure');
        jsonLdReason = 'html_unavailable';
      } else {
        htmlText = decodeHtmlBody(htmlFetch.body);
        if (htmlText === null) {
          htmlReason = 'body_decode_failed';
          jsonLdReason = 'html_unavailable';
        } else {
          inputs.push({ source: 'html', relativePath: 'html.html', mediaType: 'text/html', contents: htmlText });
          const extracted = extractHtmlEvidence(htmlText);
          canonicalPresent = extracted.canonicalHref !== null;
          htmlReason = extracted.reasonCode;
          const normalized = normalizeJsonLd(extracted.blocks, admin.product.variants.map(variant => variant.legacyResourceId));
          jsonLdBlocks = extracted.blocks.length;
          validJsonLdBlocks = normalized.validBlockCount;
          claims = normalized.claims;
          jsonLdPresence = extracted.blocks.length === 0 ? 'absent' : 'present';
          jsonLdReason = extracted.reasonCode !== null ? 'jsonld_budget_exceeded' : normalized.reasonCode;
          inputs.push({
            source: 'jsonld', relativePath: 'jsonld.json', mediaType: 'application/json',
            contents: JSON.stringify({ canonicalHref: extracted.canonicalHref, blocks: normalized.blocks, claims }, null, 2) + '\n',
          });
        }
      }
    }
  }

  let browserEvidence: BrowserEvidence | null = null;
  let browserReason: BundleReasonCode | null = null;
  if (options.browser) {
    if (admin.product.onlineStoreUrl === null) browserReason = 'not_published_to_online_store';
    else if (ajaxProduct === null || ajaxReason !== null) browserReason = 'browser_prerequisite_unavailable';
    else {
      browserEvidence = await dependencies.collectBrowser(admin, ajaxProduct, options.cartAdd === true);
      browserReason = reason(browserEvidence.reasonCode);
      inputs.push({ source: 'browser', relativePath: 'browser.json', mediaType: 'application/json', contents: JSON.stringify(browserEvidence, null, 2) + '\n' });
    }
  }

  const artifacts = inputs.map(describeBundleArtifact);
  const completedAt = dependencies.now().toISOString();
  const window = { startedAt, completedAt };
  const envelope = (
    sourceReason: BundleReasonCode | null,
    source: 'admin' | 'ajax' | 'html' | 'jsonld' | 'browser',
    itemCount: number,
    fetch: AjaxFetchResult | null = null,
  ) => ({
    outcome: sourceReason === null ? 'observed' as const : 'inconclusive' as const,
    reasonCode: sourceReason,
    observationWindow: source === 'admin' ? admin.observationWindow : window,
    artifactRefs: refsFor(source, artifacts),
    itemCount,
    status: fetch?.status ?? null,
    contentType: fetch?.contentType ?? null,
  });
  const sources = {
      admin: envelope(null, 'admin', admin.product.variants.length),
      ajax: envelope(ajaxReason, 'ajax', ajaxVariantCount, ajaxFetch),
      html: envelope(htmlReason, 'html', htmlText === null ? 0 : 1, htmlFetch),
      jsonld: {
        ...envelope(jsonLdReason, 'jsonld', claims.length, htmlFetch),
        presence: jsonLdPresence,
        blockCount: jsonLdBlocks,
        validBlockCount: validJsonLdBlocks,
        claims,
      },
      ...(options.browser ? { browser: envelope(browserReason, 'browser', browserEvidence?.observations.length ?? 0) } : {}),
    };
  const bundle = productEvidenceBundleSchema.parse({
    schemaVersion: options.browser ? 2 : 1,
    runId,
    productId,
    collectionStatus: [ajaxReason, htmlReason, jsonLdReason, ...(options.browser ? [browserReason] : [])].every(value => value === null) ? 'complete' : 'partial',
    observationWindow: window,
    sources,
    artifacts,
    limitations: options.browser ? [
      'Dawn-compatible product forms, one storefront locale/market, and ordinary physical variants only.',
      'Browser verdicts describe this CLI host and observation window, not every shopper context.',
      'Checkout, account, payment, third-party requests, and persistent browser state are blocked.',
    ] : [
      'Collection-only evidence; no availability contradiction, score, incident, or remediation is asserted.',
      'Public observations are cookieless requests from this CLI host and network context.',
      'HTML is not rendered and scripts are never executed; JSON-LD is parsed as inline data only.',
    ],
  });
  const saved = await dependencies.saveBundle(directory, config.shop, productId, runId, inputs, bundle);
  if (!options.browser) return { bundle: saved };
  const evaluations: RuleEvaluation[] = [];
  const matches = [];
  for (const variant of admin.product.variants) {
    const claim = claims.find(value => value.matchedLegacyVariantId === variant.legacyResourceId) ?? null;
    const diagnostic = evaluateVariantDiagnostics({
      admin, variantId: variant.id, evidenceRunId: runId, evaluatedAt: completedAt,
      jsonLd: {
        sourceOutcome: jsonLdReason === null ? 'observed' : 'inconclusive',
        reference: claim === null ? null : { source: 'jsonld', legacyVariantId: claim.matchedLegacyVariantId, sku: claim.sku, selectedOptions: null },
        claimKind: claim?.kind ?? null, availabilityCanonical: claim?.availabilityCanonical ?? null,
        coherentClaimCount: claims.filter(value => value.matchedLegacyVariantId === variant.legacyResourceId).length,
      },
      browser: browserEvidence?.observations.find(value => value.requestedVariantId === variant.id) ?? null,
    });
    evaluations.push(...diagnostic.evaluations); matches.push(...diagnostic.matches);
  }
  const readiness = scoreInventorySearchReadiness({
    evaluations, matches,
    structuredData: {
      sourceOutcome: jsonLdReason === null ? 'observed' : 'inconclusive', presence: jsonLdPresence,
      malformedBlockCount: jsonLdReason === 'malformed_jsonld' ? 1 : 0,
      variantOfferCount: claims.filter(value => value.kind === 'Offer' && value.matchedLegacyVariantId !== null).length,
      supportedAvailabilityCount: claims.filter(value => value.kind === 'Offer' && value.matchedLegacyVariantId !== null && value.availabilityCanonical !== null).length,
    },
    adminContent: adminContentForReadiness(admin),
  });
  await dependencies.persistDiagnostics(directory, config.shop, productId, {
    evidenceRunId: runId, evaluatedAt: completedAt, evaluations, readiness,
  });
  return { bundle: saved, evaluations, readinessTotal: readiness.total };
}
