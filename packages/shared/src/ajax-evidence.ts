import { z } from 'zod';
import { canonicalUtcTimestampSchema } from './catalog.js';
import { shopifyProductGidSchema } from './admin-evidence.js';

export const ajaxReasonCodeSchema = z.enum([
  'not_published_to_online_store',
  'invalid_online_store_url',
  'dns_resolution_failed',
  'unsafe_network_address',
  'redirect_observed',
  'http_unauthorized',
  'http_not_found',
  'http_status',
  'timeout',
  'transport_failure',
  'body_too_large',
  'unsupported_content_encoding',
  'non_json_content_type',
  'non_html_content_type',
  'unsupported_charset',
  'body_decode_failed',
  'malformed_json',
  'malformed_ajax_contract',
  'product_id_mismatch',
  'handle_mismatch',
  'duplicate_admin_legacy_id',
  'duplicate_ajax_variant_id',
  'missing_ajax_variant',
  'unexpected_ajax_variant',
  'variant_limit_exceeded',
]);

const decimalIdSchema = z.string().regex(/^(0|[1-9]\d*)$/);

const ajaxVariantSchema = z.object({
  id: decimalIdSchema,
  available: z.boolean().nullable(),
  inventoryManagement: z.string().nullable(),
  requiresSellingPlan: z.boolean().nullable(),
  sellingPlanAllocations: z.array(z.object({
    sellingPlanId: decimalIdSchema,
    sellingPlanGroupId: decimalIdSchema,
  })),
});

export const ajaxEvidenceReportSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal('ajax_only'),
  source: z.literal('shopify_ajax_product'),
  outcome: z.enum(['observed', 'inconclusive']),
  reasonCode: ajaxReasonCodeSchema.nullable(),
  productId: shopifyProductGidSchema,
  observationWindow: z.object({
    startedAt: canonicalUtcTimestampSchema,
    completedAt: canonicalUtcTimestampSchema,
  }).refine(
    window => Date.parse(window.completedAt) >= Date.parse(window.startedAt),
    'Observation completion cannot precede its start.',
  ),
  requestContext: z.object({
    kind: z.literal('unauthenticated_cli_host'),
    cookiesSent: z.literal(false),
    explicitCountry: z.null(),
    language: z.null(),
    localePath: z.string().regex(/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).nullable(),
  }),
  http: z.object({
    status: z.number().int().min(100).max(599).nullable(),
    contentType: z.string().max(100).nullable(),
    redirectObserved: z.boolean(),
  }),
  body: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    byteCount: z.number().int().nonnegative().nullable(),
  }),
  complete: z.boolean(),
  matchCounts: z.object({
    adminVariants: z.number().int().nonnegative(),
    ajaxVariants: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
  }),
  availabilityCounts: z.object({
    available: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }).nullable(),
  adminContext: z.object({
    observedAt: canonicalUtcTimestampSchema,
    productUpdatedAt: canonicalUtcTimestampSchema,
    variants: z.array(z.object({
      id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
      legacyResourceId: decimalIdSchema,
      updatedAt: canonicalUtcTimestampSchema,
      inventoryItemUpdatedAt: canonicalUtcTimestampSchema,
    })),
  }),
  ajaxProduct: z.object({
    id: decimalIdSchema,
    handle: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    available: z.boolean().nullable(),
    requiresSellingPlan: z.boolean().nullable(),
    variants: z.array(ajaxVariantSchema),
  }).nullable(),
  limitations: z.array(z.string().min(1)).min(1),
}).superRefine((report, context) => {
  if (report.outcome === 'observed' && (
    report.reasonCode !== null || report.ajaxProduct === null || !report.complete ||
    report.availabilityCounts === null || report.body.sha256 === null || report.body.byteCount === null
  )) {
    context.addIssue({ code: 'custom', message: 'Observed Ajax evidence must be complete.' });
  }
  if (report.outcome === 'inconclusive' && (
    report.reasonCode === null || report.complete || report.availabilityCounts !== null
  )) {
    context.addIssue({ code: 'custom', message: 'Inconclusive Ajax evidence must be incomplete and include a reason.' });
  }
});

export type AjaxReasonCode = z.infer<typeof ajaxReasonCodeSchema>;
export type AjaxEvidenceReport = z.infer<typeof ajaxEvidenceReportSchema>;
export type AjaxNormalizedProduct = NonNullable<AjaxEvidenceReport['ajaxProduct']>;
