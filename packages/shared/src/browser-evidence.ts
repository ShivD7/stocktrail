import { z } from 'zod';
import { canonicalUtcTimestampSchema } from './catalog.js';
import { browserVariantObservationSchema } from './diagnostics.js';

export const browserReasonCodeSchema = z.enum([
  'not_published_to_online_store', 'invalid_online_store_url', 'unsafe_network_address',
  'dns_resolution_failed', 'browser_unavailable', 'navigation_failed', 'timeout',
  'browser_prerequisite_unavailable',
  'http_unauthorized', 'http_not_found', 'rate_limited', 'redirect_observed',
  'http_status',
  'password_or_challenge', 'product_identity_mismatch', 'variant_identity_mismatch',
  'missing_product_form', 'ambiguous_product_form', 'missing_add_control',
  'ambiguous_add_control', 'obscured_add_control', 'selection_failed',
  'unsupported_cart_probe', 'cart_not_empty', 'cart_response_mismatch',
  'cart_verification_failed', 'cart_cleanup_failed',
]);

export const browserVariantEvidenceSchema = browserVariantObservationSchema.safeExtend({
  reasonCode: browserReasonCodeSchema.nullable(),
  controlVisible: z.boolean(),
  controlEnabled: z.boolean().nullable(),
  controlDisabled: z.boolean().nullable(),
  ariaDisabled: z.boolean().nullable(),
  controlLabel: z.string().max(120).nullable(),
});

export const browserEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal('browser'),
  outcome: z.enum(['observed', 'inconclusive']),
  reasonCode: browserReasonCodeSchema.nullable(),
  observationWindow: z.object({
    startedAt: canonicalUtcTimestampSchema,
    completedAt: canonicalUtcTimestampSchema,
  }),
  cartAuthorized: z.boolean(),
  observations: z.array(browserVariantEvidenceSchema),
  limitations: z.array(z.string().min(1)),
}).superRefine((value, context) => {
  if ((value.outcome === 'observed') !== (value.reasonCode === null)) {
    context.addIssue({ code: 'custom', message: 'Browser evidence outcome and reason are inconsistent.' });
  }
});

export type BrowserReasonCode = z.infer<typeof browserReasonCodeSchema>;
export type BrowserEvidence = z.infer<typeof browserEvidenceSchema>;
