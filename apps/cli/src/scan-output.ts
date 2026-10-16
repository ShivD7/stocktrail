import type { AdminScanResult } from '../../../packages/agent/src/admin-scan.js';

export function formatAdminScan(result: AdminScanResult): string[] {
  return [
    'ADMIN ONLY — Shopify Admin evidence; not a storefront verdict.',
    `Variants: ${result.report.product.variants.length}`,
    `Pages: ${result.report.pageCount}`,
    'Evidence saved locally.',
  ];
}
