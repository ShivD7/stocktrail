import { z } from 'zod';
import { canonicalUtcTimestampSchema } from './catalog.js';
import { shopifyProductGidSchema } from './admin-evidence.js';

export const bundleSourceSchema = z.enum(['admin', 'ajax', 'html', 'jsonld']);
export const bundleArtifactSourceSchema = z.enum(['admin', 'ajax', 'html', 'jsonld', 'bundle']);
export const bundleOutcomeSchema = z.enum(['observed', 'inconclusive']);
export const bundleReasonCodeSchema = z.enum([
  'not_published_to_online_store', 'invalid_online_store_url', 'dns_resolution_failed',
  'unsafe_network_address', 'redirect_observed', 'http_unauthorized', 'http_not_found',
  'http_status', 'timeout', 'transport_failure', 'body_too_large',
  'unsupported_content_encoding', 'non_json_content_type', 'non_html_content_type',
  'unsupported_charset', 'body_decode_failed', 'malformed_json', 'malformed_ajax_contract',
  'product_id_mismatch', 'handle_mismatch', 'duplicate_admin_legacy_id',
  'duplicate_ajax_variant_id', 'missing_ajax_variant', 'unexpected_ajax_variant',
  'variant_limit_exceeded', 'html_budget_exceeded', 'malformed_jsonld',
  'jsonld_budget_exceeded', 'html_unavailable',
]);

const observationWindowSchema = z.object({
  startedAt: canonicalUtcTimestampSchema,
  completedAt: canonicalUtcTimestampSchema,
}).refine(value => Date.parse(value.completedAt) >= Date.parse(value.startedAt));

export const bundleArtifactSchema = z.object({
  source: bundleArtifactSourceSchema,
  relativePath: z.enum(['admin.json', 'ajax.json', 'html.html', 'jsonld.json', 'bundle.json']),
  mediaType: z.enum(['application/json', 'text/html']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});

const sourceEnvelopeSchema = z.object({
  outcome: bundleOutcomeSchema,
  reasonCode: bundleReasonCodeSchema.nullable(),
  observationWindow: observationWindowSchema,
  artifactRefs: z.array(bundleArtifactSchema),
  itemCount: z.number().int().nonnegative(),
  status: z.number().int().min(100).max(599).nullable(),
  contentType: z.string().max(100).nullable(),
}).superRefine((value, context) => {
  if ((value.outcome === 'observed') !== (value.reasonCode === null)) {
    context.addIssue({ code: 'custom', message: 'Source outcome and reason are inconsistent.' });
  }
});

export const jsonLdClaimSchema = z.object({
  blockIndex: z.number().int().nonnegative(),
  path: z.string().min(1).max(1_000),
  kind: z.enum(['Product', 'ProductGroup', 'Offer', 'AggregateOffer']),
  id: z.string().nullable(),
  url: z.string().nullable(),
  sku: z.string().nullable(),
  gtin: z.string().nullable(),
  mpn: z.string().nullable(),
  productGroupId: z.string().nullable(),
  variesBy: z.array(z.string()),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  availabilityRaw: z.string().nullable(),
  availabilityCanonical: z.string().nullable(),
  parent: z.string().nullable(),
  urlVariantId: z.string().nullable(),
  matchedLegacyVariantId: z.string().nullable(),
});

export const productEvidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  productId: shopifyProductGidSchema,
  collectionStatus: z.enum(['complete', 'partial']),
  observationWindow: observationWindowSchema,
  sources: z.object({
    admin: sourceEnvelopeSchema,
    ajax: sourceEnvelopeSchema,
    html: sourceEnvelopeSchema,
    jsonld: sourceEnvelopeSchema.extend({
      presence: z.enum(['present', 'absent', 'unknown']),
      blockCount: z.number().int().nonnegative(),
      validBlockCount: z.number().int().nonnegative(),
      claims: z.array(jsonLdClaimSchema),
    }),
  }),
  artifacts: z.array(bundleArtifactSchema),
  limitations: z.array(z.string().min(1)).min(1),
});

export type BundleSource = z.infer<typeof bundleSourceSchema>;
export type BundleArtifactSource = z.infer<typeof bundleArtifactSourceSchema>;
export type BundleReasonCode = z.infer<typeof bundleReasonCodeSchema>;
export type BundleArtifact = z.infer<typeof bundleArtifactSchema>;
export type JsonLdClaim = z.infer<typeof jsonLdClaimSchema>;
export type ProductEvidenceBundle = z.infer<typeof productEvidenceBundleSchema>;
