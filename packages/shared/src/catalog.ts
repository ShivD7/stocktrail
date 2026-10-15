import { z } from 'zod';

export const selectedOptionSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const catalogVariantSchema = z.object({
  id: z.string().min(1),
  legacyResourceId: z.string().regex(/^\d+$/),
  sku: z.string().nullable(),
  selectedOptions: z.array(selectedOptionSchema),
  inventoryPolicy: z.enum(['DENY', 'CONTINUE']),
  inventoryQuantity: z.number().int().nullable(),
  sellableOnlineQuantity: z.number().int(),
  updatedAt: z.string().min(1),
  inventoryItem: z.object({ tracked: z.boolean() }),
});

export const catalogProvenanceSchema = z.object({
  observedAt: z.string().refine(
    value => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    },
    'observedAt must be an ISO UTC timestamp.',
  ),
  evidenceSource: z.literal('shopify_admin_graphql'),
  apiVersion: z.literal('2026-10'),
});

export const catalogProductSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  descriptionHtml: z.string(),
  seo: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
  }),
  handle: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']),
  updatedAt: z.string().min(1),
  onlineStoreUrl: z.string().nullable(),
  publishedToOnlineStore: z.boolean(),
  variants: z.array(catalogVariantSchema),
});

export type CatalogVariant = z.infer<typeof catalogVariantSchema>;
export type CatalogProduct = z.infer<typeof catalogProductSchema>;
export type CatalogProvenance = z.infer<typeof catalogProvenanceSchema>;
