import {
  adminAvailabilitySchema,
  type AdminAvailability,
} from '../../shared/src/diagnostics.js';
import type { AdminEvidenceReport } from '../../shared/src/admin-evidence.js';

type AdminVariant = AdminEvidenceReport['product']['variants'][number];

export function deriveExpectedPurchasable(
  report: AdminEvidenceReport | null,
  variant: AdminVariant | null,
): AdminAvailability {
  const unavailable = report === null || variant === null;
  const productId = report?.productId ?? 'gid://shopify/Product/0';
  const variantId = variant?.id ?? 'gid://shopify/ProductVariant/0';
  const legacyVariantId = variant?.legacyResourceId ?? '0';
  const evidence = {
    productStatus: report?.product.status ?? null,
    publishedToOnlineStore: report === null ? null : report.product.onlineStoreUrl !== null,
    inventoryTracked: variant?.inventoryItem.tracked ?? null,
    inventoryPolicy: variant?.inventoryPolicy ?? null,
    sellableOnlineQuantity: variant?.sellableOnlineQuantity ?? null,
    inventoryQuantity: variant?.inventoryQuantity ?? null,
  };
  if (unavailable) {
    return adminAvailabilitySchema.parse({
      productId, variantId, legacyVariantId, state: 'inconclusive',
      reasonCode: 'admin_evidence_unavailable', evidence,
    });
  }
  if (report.product.status === 'DRAFT' || report.product.status === 'ARCHIVED') {
    return adminAvailabilitySchema.parse({
      productId, variantId, legacyVariantId, state: 'unavailable',
      reasonCode: 'product_not_active', evidence,
    });
  }
  if (report.product.onlineStoreUrl === null) {
    return adminAvailabilitySchema.parse({
      productId, variantId, legacyVariantId, state: 'unavailable',
      reasonCode: 'not_published', evidence,
    });
  }
  if (variant.inventoryPolicy === 'CONTINUE') {
    return adminAvailabilitySchema.parse({
      productId, variantId, legacyVariantId, state: 'purchasable',
      reasonCode: 'continue_selling', evidence,
    });
  }
  if (!variant.inventoryItem.tracked) {
    return adminAvailabilitySchema.parse({
      productId, variantId, legacyVariantId, state: 'purchasable',
      reasonCode: 'inventory_untracked', evidence,
    });
  }
  const positive = variant.sellableOnlineQuantity > 0;
  return adminAvailabilitySchema.parse({
    productId, variantId, legacyVariantId,
    state: positive ? 'purchasable' : 'unavailable',
    reasonCode: positive ? 'sellable_quantity_positive' : 'sellable_quantity_nonpositive',
    evidence,
  });
}
