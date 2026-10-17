import { z } from 'zod';
import { canonicalUtcTimestampSchema } from './catalog.js';
import { shopifyProductGidSchema } from './admin-evidence.js';
import { readinessScoreSchema } from './readiness.js';

export const proposalFieldSchema = z.enum([
  'title', 'descriptionHtml', 'seo.title', 'seo.description',
]);

export const productContentSchema = z.object({
  title: z.string(),
  descriptionHtml: z.string(),
  seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }).strict(),
}).strict();

export const proposalSnapshotSchema = z.object({
  productId: shopifyProductGidSchema,
  productUpdatedAt: canonicalUtcTimestampSchema,
  latestInventoryUpdatedAt: canonicalUtcTimestampSchema,
  observedAt: canonicalUtcTimestampSchema,
  evidenceRunId: z.string().uuid(),
  content: productContentSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const proposalRuleCodeSchema = z.enum([
  'ST-G001_REMOVE_TRANSIENT_CLAIM',
  'ST-G002_COPY_TITLE_TO_EMPTY_SEO_TITLE',
  'ST-G003_COPY_DESCRIPTION_TO_EMPTY_SEO_DESCRIPTION',
]);

export const proposalValidationCodeSchema = z.enum([
  'PV_UNAPPROVED_FIELD', 'PV_DUPLICATE_FIELD', 'PV_NO_EFFECT',
  'PV_BASE_EVIDENCE_INVALID', 'PV_ARTIFACT_HASH_MISMATCH',
  'PV_SOURCE_ATTRIBUTION_MISSING', 'PV_UNATTRIBUTED_INSERTION',
  'PV_PROVENANCE_REPLAY_FAILED', 'PV_TRANSIENT_CLAIM_REMAINS',
  'PV_UNSAFE_MIXED_CLAIM', 'PV_EMPTY_TITLE', 'PV_EMPTY_CHANGED_FIELD',
  'PV_TITLE_TOO_LONG', 'PV_DESCRIPTION_TOO_LARGE', 'PV_SEO_TITLE_TOO_LONG',
  'PV_SEO_DESCRIPTION_TOO_LONG', 'PV_UNSAFE_HTML_SHAPE', 'PV_UNBALANCED_HTML',
  'PV_ACTIVE_CONTENT_CHANGED', 'PV_INFORMATION_LOSS', 'PV_UNAUTHORIZED_REORDER',
  'PV_READINESS_REGRESSION',
]);

export const proposalWarningCodeSchema = z.enum([
  'PW_TRANSIENT_CLAIM_REINTRODUCED', 'PW_READINESS_REGRESSION',
]);

export const provenanceOperationSchema = z.object({
  sourceField: proposalFieldSchema,
  operation: z.enum(['copy', 'delete_transient_claim']),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).strict().refine(value => value.end >= value.start, 'Invalid provenance range.');

export const proposalFieldChangeSchema = z.object({
  field: proposalFieldSchema,
  before: z.string().nullable(),
  after: z.string().nullable(),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  ruleCodes: z.array(proposalRuleCodeSchema).min(1),
  provenance: z.array(provenanceOperationSchema).min(1),
}).strict();

export const proposalValidationSchema = z.object({
  valid: z.boolean(),
  reasonCodes: z.array(proposalValidationCodeSchema),
  warningCodes: z.array(proposalWarningCodeSchema),
}).strict().superRefine((value, context) => {
  if (value.valid === (value.reasonCodes.length > 0)) {
    context.addIssue({ code: 'custom', message: 'Proposal validation state is inconsistent.' });
  }
});

export const proposalStatusSchema = z.enum([
  'ready', 'rejected', 'approved', 'applying', 'stale',
  'not_applied', 'ambiguous', 'applied',
]);
export const proposalVerificationStatusSchema = z.enum([
  'not_started', 'pending', 'verified', 'failed', 'inconclusive', 'drifted',
]);
export const proposalKindSchema = z.enum(['improvement', 'revert']);

export const proposalArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  kind: proposalKindSchema,
  parentProposalId: z.string().uuid().nullable(),
  productId: shopifyProductGidSchema,
  sourceEvidenceRunId: z.string().uuid(),
  base: proposalSnapshotSchema,
  candidate: productContentSchema,
  changes: z.array(proposalFieldChangeSchema).min(1),
  currentReadiness: readinessScoreSchema,
  predictedReadiness: readinessScoreSchema,
  validation: proposalValidationSchema,
  createdAt: canonicalUtcTimestampSchema,
}).strict().superRefine((value, context) => {
  const fields = value.changes.map(change => change.field);
  if (new Set(fields).size !== fields.length) {
    context.addIssue({ code: 'custom', message: 'Proposal fields must be unique.' });
  }
});

export type ProposalField = z.infer<typeof proposalFieldSchema>;
export type ProductContent = z.infer<typeof productContentSchema>;
export type ProposalSnapshot = z.infer<typeof proposalSnapshotSchema>;
export type ProposalRuleCode = z.infer<typeof proposalRuleCodeSchema>;
export type ProposalValidationCode = z.infer<typeof proposalValidationCodeSchema>;
export type ProposalWarningCode = z.infer<typeof proposalWarningCodeSchema>;
export type ProposalFieldChange = z.infer<typeof proposalFieldChangeSchema>;
export type ProposalValidation = z.infer<typeof proposalValidationSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalVerificationStatus = z.infer<typeof proposalVerificationStatusSchema>;
export type ProposalKind = z.infer<typeof proposalKindSchema>;
export type ProposalArtifact = z.infer<typeof proposalArtifactSchema>;
