import type { ImportPreviewSummary } from '../../../packages/agent/src/import.js';

export function formatImportPreview(summary: ImportPreviewSummary): string[] {
  return [
    'PREVIEW COMPLETE — read-only; no catalog or evidence files were written.',
    `Products: ${summary.productCount}`,
    `Variants: ${summary.variantCount}`,
    `Published to online store: ${summary.publishedProductCount}`,
  ];
}
