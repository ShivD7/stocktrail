import { readConfig, type Config } from './config.js';
import { readStoredToken } from './auth.js';
import {
  validateAdminScanTarget,
  writePrivateJsonReport,
  type EvidenceStorageDependencies,
} from './admin-scan.js';
import {
  ajaxEvidenceReportSchema,
  type AjaxEvidenceReport,
  type AjaxNormalizedProduct,
  type AjaxReasonCode,
} from '../../shared/src/ajax-evidence.js';
import { assertShopifyProductGid } from '../../shared/src/admin-evidence.js';
import { ShopifyAdminClient } from '../../shopify/src/admin-client.js';
import {
  readAdminProductEvidence,
} from '../../shopify/src/admin-evidence.js';
import {
  deriveAjaxProductTarget,
  fetchAjaxProduct,
  normalizeAjaxProduct,
  type AjaxFetchResult,
  type DerivedAjaxTarget,
} from '../../shopify/src/ajax.js';
import type { AdminEvidenceReport } from '../../shared/src/admin-evidence.js';

export type AjaxScanResult = { report: AjaxEvidenceReport; path: string };

export type AjaxScanDependencies = {
  readConfig(directory: string): Promise<Config>;
  validateTarget(directory: string, shop: string, productId: string): Promise<void>;
  readToken(shop: string): Promise<string>;
  readAdmin(shop: string, token: string, productId: string): Promise<AdminEvidenceReport>;
  fetchAjax(target: DerivedAjaxTarget): Promise<AjaxFetchResult>;
  writeEvidence(directory: string, report: AjaxEvidenceReport): Promise<string>;
  now(): Date;
};

export async function writeAjaxEvidence(
  directory: string,
  reportInput: AjaxEvidenceReport,
  storage?: EvidenceStorageDependencies,
): Promise<string> {
  const parsed = ajaxEvidenceReportSchema.safeParse(reportInput);
  if (!parsed.success) throw new Error('Cannot save an invalid Ajax evidence report.');
  return writePrivateJsonReport(directory, 'ajax', JSON.stringify(parsed.data, null, 2) + '\n', storage);
}

const defaultDependencies: AjaxScanDependencies = {
  readConfig,
  validateTarget: validateAdminScanTarget,
  readToken: readStoredToken,
  async readAdmin(shop, token, productId) {
    return readAdminProductEvidence(new ShopifyAdminClient(shop, token), productId);
  },
  fetchAjax: fetchAjaxProduct,
  writeEvidence: writeAjaxEvidence,
  now: () => new Date(),
};

type ReportState = {
  reasonCode: AjaxReasonCode | null;
  target: DerivedAjaxTarget | null;
  fetch: AjaxFetchResult | null;
  ajaxProduct: AjaxNormalizedProduct | null;
  matched: number;
};

const limitations = [
  'Cookieless public Ajax JSON observation from this CLI host and network context only.',
  'This is not cart, checkout, market-wide, or universal shopper availability evidence.',
  'No storefront HTML, rendered UI, customer session, or authenticated buyer context was observed.',
];

function productDecimalId(productId: string): string {
  return productId.slice(productId.lastIndexOf('/') + 1);
}

function buildReport(
  productId: string,
  startedAt: string,
  completedAt: string,
  admin: AdminEvidenceReport,
  state: ReportState,
): AjaxEvidenceReport {
  const adminVariants = admin.product.variants.map(variant => ({
    id: variant.id,
    legacyResourceId: variant.legacyResourceId,
    updatedAt: variant.updatedAt,
    inventoryItemUpdatedAt: variant.inventoryItem.updatedAt,
  }));
  const observed = state.reasonCode === null && state.ajaxProduct !== null;
  const available = observed
    ? state.ajaxProduct!.variants.filter(variant => variant.available === true).length
    : 0;
  const unavailable = observed
    ? state.ajaxProduct!.variants.filter(variant => variant.available === false).length
    : 0;
  return ajaxEvidenceReportSchema.parse({
    schemaVersion: 1,
    mode: 'ajax_only',
    source: 'shopify_ajax_product',
    outcome: observed ? 'observed' : 'inconclusive',
    reasonCode: state.reasonCode,
    productId,
    observationWindow: { startedAt, completedAt },
    requestContext: {
      kind: 'unauthenticated_cli_host',
      cookiesSent: false,
      explicitCountry: null,
      language: null,
      localePath: state.target?.localePath ?? null,
    },
    http: {
      status: state.fetch?.status ?? null,
      contentType: state.fetch?.contentType ?? null,
      redirectObserved: state.fetch?.redirectObserved ?? false,
    },
    body: {
      sha256: state.fetch?.sha256 ?? null,
      byteCount: state.fetch?.byteCount ?? null,
    },
    complete: observed,
    matchCounts: {
      adminVariants: adminVariants.length,
      ajaxVariants: state.ajaxProduct?.variants.length ?? 0,
      matched: state.matched,
    },
    availabilityCounts: observed ? { available, unavailable } : null,
    adminContext: {
      observedAt: admin.observationWindow.completedAt,
      productUpdatedAt: admin.product.updatedAt,
      variants: adminVariants,
    },
    ajaxProduct: state.ajaxProduct,
    limitations,
  });
}

function matchEvidence(
  productId: string,
  expectedHandle: string,
  admin: AdminEvidenceReport,
  ajaxProduct: AjaxNormalizedProduct,
): { reasonCode: AjaxReasonCode | null; matched: number } {
  if (ajaxProduct.id !== productDecimalId(productId)) return { reasonCode: 'product_id_mismatch', matched: 0 };
  if (ajaxProduct.handle !== expectedHandle) return { reasonCode: 'handle_mismatch', matched: 0 };
  if (admin.product.variants.length > 250 || ajaxProduct.variants.length > 250) {
    return { reasonCode: 'variant_limit_exceeded', matched: 0 };
  }
  const adminIds = new Set<string>();
  for (const variant of admin.product.variants) {
    if (adminIds.has(variant.legacyResourceId)) {
      return { reasonCode: 'duplicate_admin_legacy_id', matched: 0 };
    }
    adminIds.add(variant.legacyResourceId);
  }
  const ajaxIds = new Set(ajaxProduct.variants.map(variant => variant.id));
  let matched = 0;
  for (const id of ajaxIds) {
    if (!adminIds.has(id)) return { reasonCode: 'unexpected_ajax_variant', matched };
    matched += 1;
  }
  for (const id of adminIds) {
    if (!ajaxIds.has(id)) return { reasonCode: 'missing_ajax_variant', matched };
  }
  return { reasonCode: null, matched };
}

export async function scanAjaxEvidence(
  directory: string,
  productId: string,
  dependencies: AjaxScanDependencies = defaultDependencies,
): Promise<AjaxScanResult> {
  assertShopifyProductGid(productId);
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  await dependencies.validateTarget(directory, config.shop, productId);
  const token = await dependencies.readToken(config.shop);
  const startedAt = dependencies.now().toISOString();
  const admin = await dependencies.readAdmin(config.shop, token, productId);
  let state: ReportState = {
    reasonCode: null,
    target: null,
    fetch: null,
    ajaxProduct: null,
    matched: 0,
  };

  const adminLegacyIds = new Set(admin.product.variants.map(variant => variant.legacyResourceId));
  if (adminLegacyIds.size !== admin.product.variants.length) state.reasonCode = 'duplicate_admin_legacy_id';
  else if (admin.product.variants.length > 250) state.reasonCode = 'variant_limit_exceeded';
  else if (admin.product.onlineStoreUrl === null) state.reasonCode = 'not_published_to_online_store';
  else {
    try {
      state.target = deriveAjaxProductTarget(admin.product.onlineStoreUrl);
    } catch {
      state.reasonCode = 'invalid_online_store_url';
    }
  }

  if (state.reasonCode === null && state.target !== null) {
    state.fetch = await dependencies.fetchAjax(state.target);
    if (state.fetch.reasonCode !== null || state.fetch.body === null) {
      state.reasonCode = state.fetch.reasonCode ?? 'transport_failure';
    } else {
      const normalized = normalizeAjaxProduct(state.fetch.body);
      if (!normalized.ok) state.reasonCode = normalized.reasonCode;
      else {
        state.ajaxProduct = normalized.product;
        const matched = matchEvidence(productId, state.target.handle, admin, normalized.product);
        state.reasonCode = matched.reasonCode;
        state.matched = matched.matched;
      }
    }
  }

  const report = buildReport(
    productId,
    startedAt,
    dependencies.now().toISOString(),
    admin,
    state,
  );
  const path = await dependencies.writeEvidence(directory, report);
  return { report, path };
}
