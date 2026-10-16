import { z } from 'zod';
import { canonicalUtcTimestampSchema, selectedOptionSchema } from './catalog.js';

export const shopifyProductGidSchema = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);

export function assertShopifyProductGid(value: string): void {
  if (!shopifyProductGidSchema.safeParse(value).success) {
    throw new Error('Product ID must be a Shopify Product GID.');
  }
}

const adminVariantEvidenceSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  legacyResourceId: z.string().regex(/^\d+$/),
  sku: z.string().nullable().optional(),
  selectedOptions: z.array(selectedOptionSchema),
  inventoryPolicy: z.enum(['DENY', 'CONTINUE']),
  inventoryQuantity: z.number().int().nullable(),
  sellableOnlineQuantity: z.number().int(),
  updatedAt: canonicalUtcTimestampSchema,
  inventoryItem: z.object({
    id: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/),
    tracked: z.boolean(),
    updatedAt: canonicalUtcTimestampSchema,
  }),
});

export const adminEvidenceReportSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal('admin_only'),
  source: z.literal('shopify_admin_graphql'),
  productId: shopifyProductGidSchema,
  observationWindow: z.object({
    startedAt: canonicalUtcTimestampSchema,
    completedAt: canonicalUtcTimestampSchema,
  }).refine(
    window => Date.parse(window.completedAt) >= Date.parse(window.startedAt),
    'Observation completion cannot precede its start.',
  ),
  apiVersion: z.object({
    requested: z.literal('2026-10'),
    response: z.literal('2026-10').nullable(),
  }),
  pageCount: z.number().int().positive(),
  complete: z.literal(true),
  limitations: z.array(z.string().min(1)).min(1),
  product: z.object({
    id: shopifyProductGidSchema,
    title: z.string().optional(),
    handle: z.string().optional(),
    descriptionHtml: z.string().optional(),
    seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']),
    onlineStoreUrl: z.string().nullable(),
    updatedAt: canonicalUtcTimestampSchema,
    variants: z.array(adminVariantEvidenceSchema),
  }),
});

export type AdminEvidenceReport = z.infer<typeof adminEvidenceReportSchema>;
