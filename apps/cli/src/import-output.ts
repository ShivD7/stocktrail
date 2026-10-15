import type { ImportPreviewSummary } from '../../../packages/agent/src/import.js';
import type { PersistentImportSummary } from '../../../packages/agent/src/import.js';

export function formatImportPreview(summary: ImportPreviewSummary): string[] {
  return [
    'PREVIEW COMPLETE — read-only; no catalog or evidence files were written.',
    `Products: ${summary.productCount}`,
    `Variants: ${summary.variantCount}`,
    `Published to online store: ${summary.publishedProductCount}`,
  ];
}

export function formatPersistentImport(summary: PersistentImportSummary): string[] {
  return [
    'IMPORT COMPLETE — catalog data was saved locally; Shopify was not modified.',
    `Products imported: ${summary.productCount}`,
    `Variants imported: ${summary.variantCount}`,
    `Published to online store: ${summary.publishedProductCount}`,
    `Products marked inactive: ${summary.deactivatedProductCount}`,
    summary.fullSnapshot
      ? 'Snapshot: complete catalog.'
      : 'Snapshot: limited; unseen products were left unchanged.',
  ];
}
