import { z } from 'zod';
import { canonicalUtcTimestampSchema, selectedOptionSchema } from './catalog.js';

export const ruleIdSchema = z.enum(['ST-001', 'ST-002', 'ST-003']);
export const ruleResultSchema = z.enum(['pass', 'fail', 'inconclusive', 'not_applicable']);
export const matchMethodSchema = z.enum(['variant_id', 'sku', 'selected_options']);
export const matchConfidenceSchema = z.enum(['authoritative', 'strong', 'contextual']);

export const variantReferenceSchema = z.object({
  source: z.enum(['ajax', 'jsonld', 'browser']),
  legacyVariantId: z.string().regex(/^\d+$/).nullable(),
  sku: z.string().nullable(),
  selectedOptions: z.array(selectedOptionSchema).nullable(),
});

export const variantMatchSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('matched'),
    variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
    legacyVariantId: z.string().regex(/^\d+$/),
    method: matchMethodSchema,
    confidence: matchConfidenceSchema,
    corroboratingMethods: z.array(matchMethodSchema),
  }),
  z.object({
    outcome: z.literal('inconclusive'),
    reasonCode: z.enum([
      'missing_identifier', 'unknown_variant_id', 'duplicate_sku', 'ambiguous_options',
      'conflicting_identifiers', 'duplicate_source_claim', 'conflicting_source_claims',
    ]),
    candidateCount: z.number().int().nonnegative(),
  }),
]);

export const adminAvailabilitySchema = z.object({
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  legacyVariantId: z.string().regex(/^\d+$/),
  state: z.enum(['purchasable', 'unavailable', 'inconclusive']),
  reasonCode: z.enum([
    'admin_evidence_unavailable', 'product_not_active', 'not_published',
    'continue_selling', 'inventory_untracked', 'sellable_quantity_positive',
    'sellable_quantity_nonpositive',
  ]),
  evidence: z.object({
    productStatus: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']).nullable(),
    publishedToOnlineStore: z.boolean().nullable(),
    inventoryTracked: z.boolean().nullable(),
    inventoryPolicy: z.enum(['DENY', 'CONTINUE']).nullable(),
    sellableOnlineQuantity: z.number().int().nullable(),
    inventoryQuantity: z.number().int().nullable(),
  }),
});

export const browserVariantObservationSchema = z.object({
  requestedVariantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  requestedLegacyVariantId: z.string().regex(/^\d+$/),
  outcome: z.enum(['observed', 'inconclusive']),
  reasonCode: z.string().min(1).nullable(),
  selectedLegacyVariantId: z.string().regex(/^\d+$/).nullable(),
  controlState: z.enum(['enabled', 'disabled', 'missing', 'ambiguous']),
  cartOutcome: z.enum(['not_attempted', 'succeeded', 'rejected', 'inconclusive']),
  storefrontPurchasable: z.boolean().nullable(),
}).superRefine((value, context) => {
  if ((value.outcome === 'observed') !== (value.reasonCode === null)) {
    context.addIssue({ code: 'custom', message: 'Browser outcome and reason are inconsistent.' });
  }
  if (value.outcome === 'observed' && value.storefrontPurchasable === null) {
    context.addIssue({ code: 'custom', message: 'Observed browser evidence requires a verdict.' });
  }
});

export const ruleEvaluationSchema = z.object({
  schemaVersion: z.literal(1),
  ruleVersion: z.literal(1),
  ruleId: ruleIdSchema,
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  result: ruleResultSchema,
  severity: z.enum(['high', 'medium']),
  reasonCode: z.string().min(1),
  match: variantMatchSchema.nullable(),
  requiredSources: z.array(z.enum(['admin', 'ajax', 'jsonld', 'browser'])),
  evidenceRunId: z.string().uuid(),
  evaluatedAt: canonicalUtcTimestampSchema,
});

export const assertionTypeSchema = z.enum([
  'admin_unavailable_not_jsonld_in_stock',
  'admin_unavailable_not_storefront_permitted',
  'admin_sellable_not_storefront_blocked',
]);

export const regressionAssertionSchema = z.object({
  schemaVersion: z.literal(1),
  ruleVersion: z.literal(1),
  assertionType: assertionTypeSchema,
  ruleId: ruleIdSchema,
  productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
});

export type VariantReference = z.infer<typeof variantReferenceSchema>;
export type VariantMatch = z.infer<typeof variantMatchSchema>;
export type AdminAvailability = z.infer<typeof adminAvailabilitySchema>;
export type BrowserVariantObservation = z.infer<typeof browserVariantObservationSchema>;
export type RuleEvaluation = z.infer<typeof ruleEvaluationSchema>;
export type RuleId = z.infer<typeof ruleIdSchema>;
export type RuleResult = z.infer<typeof ruleResultSchema>;
export type RegressionAssertion = z.infer<typeof regressionAssertionSchema>;
