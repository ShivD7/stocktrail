import { z } from 'zod';
import { shopifyProductGidSchema } from './admin-evidence.js';
import { readinessScoreSchema } from './readiness.js';
import {
  proposalFieldSchema,
  proposalKindSchema,
  proposalStatusSchema,
  proposalValidationCodeSchema,
  proposalVerificationStatusSchema,
  proposalWarningCodeSchema,
} from './proposals.js';

const timestampSchema = z.string().datetime({ offset: true });
const uuidSchema = z.string().uuid();
const scoreSchema = z.number().int().min(0).max(100).nullable();
const boundedTextSchema = z.string().max(1_000_000);

export const dashboardIncidentStatusSchema = z.enum(['open', 'resolved', 'ignored']);
export const dashboardSeveritySchema = z.enum(['high', 'medium']);
export const dashboardAllowedActionSchema = z.enum([
  'monitor', 'unmonitor', 'scan', 'improve', 'view_proposal',
  'reject', 'apply', 'reconcile', 'create_revert',
]);

export const dashboardProposalSummarySchema = z.object({
  id: uuidSchema,
  kind: proposalKindSchema,
  status: proposalStatusSchema,
  verificationStatus: proposalVerificationStatusSchema,
  currentScore: scoreSchema,
  predictedScore: scoreSchema,
  verifiedScore: scoreSchema,
  createdAt: timestampSchema,
}).strict();

export const dashboardLatestScanSchema = z.object({
  id: uuidSchema,
  status: z.enum(['complete', 'partial']),
  completedAt: timestampSchema,
}).strict();

export const dashboardProductSummarySchema = z.object({
  productGid: shopifyProductGidSchema,
  title: z.string().max(1_000),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']),
  present: z.boolean(),
  monitored: z.boolean(),
  variantCount: z.number().int().nonnegative(),
  inventory: z.object({
    sellableVariants: z.number().int().nonnegative(),
    unavailableVariants: z.number().int().nonnegative(),
    unknownVariants: z.number().int().nonnegative(),
  }).strict(),
  latestScan: dashboardLatestScanSchema.nullable(),
  readinessScore: scoreSchema,
  weakestComponent: z.object({
    id: z.enum([
      'availability_agreement', 'variant_identity', 'structured_data_quality',
      'inventory_promise_clarity', 'stale_claim_safety',
    ]),
    outcome: z.enum(['ready', 'not_ready', 'inconclusive']),
    points: z.number().int().nonnegative().nullable(),
    weight: z.union([z.literal(30), z.literal(25), z.literal(20), z.literal(15), z.literal(10)]),
  }).strict().nullable(),
  openIncidentCount: z.number().int().nonnegative(),
  latestProposal: dashboardProposalSummarySchema.nullable(),
  allowedActions: z.array(dashboardAllowedActionSchema),
}).strict();

export const dashboardProductDetailSchema = dashboardProductSummarySchema.extend({
  productUrl: z.string().url().nullable(),
  descriptionText: z.string().max(100_000),
  seo: z.object({ title: z.string().max(10_000).nullable(), description: z.string().max(10_000).nullable() }).strict(),
  readiness: readinessScoreSchema.nullable(),
}).strict();

export const dashboardScoreDistributionSchema = z.object({
  buckets: z.array(z.object({
    minimum: z.union([z.literal(0), z.literal(20), z.literal(40), z.literal(60), z.literal(80)]),
    maximum: z.union([z.literal(19), z.literal(39), z.literal(59), z.literal(79), z.literal(100)]),
    count: z.number().int().nonnegative(),
  }).strict()).length(5),
  inconclusive: z.number().int().nonnegative(),
}).strict();

export const dashboardOverviewSchema = z.object({
  shop: z.string().nullable(),
  monitoredProducts: z.object({
    selected: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }).strict(),
  incidents: z.object({ open: z.number().int().nonnegative(), resolved: z.number().int().nonnegative(), ignored: z.number().int().nonnegative() }).strict(),
  latestScan: z.object({
    id: uuidSchema, productGid: shopifyProductGidSchema, productTitle: z.string(),
    status: z.enum(['complete', 'partial']), completedAt: timestampSchema, readinessScore: scoreSchema,
  }).strict().nullable(),
  scoreDistribution: dashboardScoreDistributionSchema,
}).strict();

export const dashboardIncidentSummarySchema = z.object({
  id: uuidSchema,
  productGid: shopifyProductGidSchema,
  productTitle: z.string(),
  variantGid: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  variantLabel: z.string(),
  ruleId: z.enum(['ST-001', 'ST-002', 'ST-003']),
  status: dashboardIncidentStatusSchema,
  severity: dashboardSeveritySchema,
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  lastEvaluatedAt: timestampSchema,
  occurrenceCount: z.number().int().positive(),
  latestReasonCode: z.string(),
}).strict();

export const dashboardSourceEvidenceSchema = z.object({
  source: z.enum(['admin', 'ajax', 'html', 'jsonld', 'browser']),
  outcome: z.enum(['observed', 'inconclusive']),
  reasonCode: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  artifactPath: z.enum(['admin.json', 'ajax.json', 'html.html', 'jsonld.json', 'browser.json']).nullable(),
}).strict();

export const dashboardIncidentPerspectiveSchema = z.object({
  perspective: z.enum(['admin', 'storefront', 'search']),
  source: z.enum(['admin', 'ajax', 'jsonld', 'browser']).nullable(),
  outcome: z.enum(['observed', 'inconclusive']),
  reasonCode: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
}).strict();

export const dashboardTestHistorySchema = z.object({
  runId: uuidSchema, outcome: z.enum(['pass', 'fail', 'inconclusive']),
  reasonCode: z.string(), completedAt: timestampSchema,
}).strict();

export const dashboardIncidentDetailSchema = dashboardIncidentSummarySchema.extend({
  productUrl: z.string().url().nullable(),
  latestEvidenceRunId: uuidSchema,
  sources: z.array(dashboardSourceEvidenceSchema),
  comparison: z.array(dashboardIncidentPerspectiveSchema).length(3),
  testHistory: z.array(dashboardTestHistorySchema).max(20),
}).strict();

export const dashboardDiffPartSchema = z.object({ kind: z.enum(['equal', 'remove', 'add']), value: boundedTextSchema }).strict();
export const dashboardFieldDiffSchema = z.object({
  field: proposalFieldSchema, mode: z.enum(['word', 'line']),
  parts: z.array(dashboardDiffPartSchema).max(4_000), truncated: z.boolean(),
}).strict();

export const dashboardProposalDetailSchema = z.object({
  id: uuidSchema,
  productGid: shopifyProductGidSchema,
  kind: proposalKindSchema,
  parentProposalId: uuidSchema.nullable(),
  status: proposalStatusSchema,
  verificationStatus: proposalVerificationStatusSchema,
  sourceEvidenceRunId: uuidSchema,
  verificationEvidenceRunId: uuidSchema.nullable(),
  changes: z.array(z.object({
    field: proposalFieldSchema,
    before: boundedTextSchema.nullable(),
    after: boundedTextSchema.nullable(),
    beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
    afterHash: z.string().regex(/^[a-f0-9]{64}$/),
    displayMode: z.literal('text'),
  }).strict()).max(4),
  diffs: z.array(dashboardFieldDiffSchema).max(4),
  validation: z.object({ valid: z.boolean(), reasonCodes: z.array(proposalValidationCodeSchema), warningCodes: z.array(proposalWarningCodeSchema) }).strict(),
  scores: z.object({ current: scoreSchema, predicted: scoreSchema, verified: scoreSchema }).strict(),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  allowedActions: z.array(dashboardAllowedActionSchema),
}).strict();

export const dashboardRerunResultSchema = z.object({
  status: z.enum(['no_tests', 'passed', 'failed', 'inconclusive']), passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), inconclusive: z.number().int().nonnegative(),
}).strict();

export const dashboardConnectionSchema = z.object({
  shop: z.string().nullable(),
  configuration: z.enum(['ready', 'unconfigured']),
  credentialStorage: z.enum(['stored', 'missing', 'unavailable', 'unconfigured']),
  catalog: z.object({ products: z.number().int().nonnegative(), variants: z.number().int().nonnegative(), imports: z.number().int().nonnegative() }).strict(),
  monitoring: z.object({ selected: z.number().int().nonnegative(), active: z.number().int().nonnegative(), limit: z.number().int().positive() }).strict(),
  localData: z.object({ evidenceRuns: z.number().int().nonnegative(), incidents: z.number().int().nonnegative(), testRuns: z.number().int().nonnegative(), retention: z.literal('manual') }).strict(),
}).strict();

export const dashboardImportRequestSchema = z.object({ limit: z.number().int().min(1).max(250) }).strict();
export const dashboardMonitoringRequestSchema = z.object({ productId: shopifyProductGidSchema, action: z.enum(['add', 'remove']) }).strict();
export const dashboardScanRequestSchema = z.object({ productId: shopifyProductGidSchema }).strict();
export const dashboardApplyRequestSchema = z.object({ confirmation: z.string().min(1).max(200), acknowledgeWarnings: z.boolean().default(false) }).strict();
export const dashboardEmptyRequestSchema = z.object({}).strict();

export const dashboardImportResultSchema = z.object({
  status: z.literal('import-complete'), productCount: z.number().int().nonnegative(), variantCount: z.number().int().nonnegative(),
  deactivatedProductCount: z.number().int().nonnegative(), publishedProductCount: z.number().int().nonnegative(), fullSnapshot: z.boolean(),
}).strict();
export const dashboardMonitoringResultSchema = z.object({ selected: z.number().int().nonnegative(), active: z.number().int().nonnegative(), limit: z.number().int().positive() }).strict();
export const dashboardScanResultSchema = z.object({ evidenceRunId: uuidSchema, collectionStatus: z.enum(['complete', 'partial']), readinessScore: scoreSchema }).strict();
export const dashboardImproveResultSchema = z.object({ proposalId: uuidSchema.nullable(), guidanceCodes: z.array(proposalValidationCodeSchema) }).strict();
export const dashboardProposalActionResultSchema = z.object({ proposalId: uuidSchema, status: proposalStatusSchema, verificationStatus: proposalVerificationStatusSchema }).strict();
export const dashboardApplyResultSchema = z.object({
  proposalId: uuidSchema, status: z.enum(['stale', 'not_applied', 'ambiguous', 'applied']),
  verification: z.enum(['not_started', 'verified', 'failed', 'inconclusive', 'drifted']),
  diagnosticOutcome: z.enum(['pass', 'fail', 'inconclusive']).nullable(), changedFields: z.array(proposalFieldSchema),
}).strict();
export const dashboardRevertResultSchema = z.object({ proposalId: uuidSchema, parentProposalId: uuidSchema, status: z.literal('ready'), warningCodes: z.array(proposalWarningCodeSchema) }).strict();

export const dashboardErrorCodeSchema = z.enum([
  'invalid_host', 'invalid_origin', 'invalid_request', 'invalid_identifier', 'unsupported_media_type',
  'body_too_large', 'not_found', 'method_not_allowed', 'operation_in_progress', 'conflict',
  'confirmation_mismatch', 'warning_acknowledgement_required', 'write_scope_required',
  'unprocessable', 'artifact_integrity_failed', 'dashboard_unavailable',
]);
export const dashboardErrorSchema = z.object({ error: dashboardErrorCodeSchema }).strict();

export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;
export type DashboardProductSummary = z.infer<typeof dashboardProductSummarySchema>;
export type DashboardProductDetail = z.infer<typeof dashboardProductDetailSchema>;
export type DashboardIncidentSummary = z.infer<typeof dashboardIncidentSummarySchema>;
export type DashboardIncidentDetail = z.infer<typeof dashboardIncidentDetailSchema>;
export type DashboardSourceEvidence = z.infer<typeof dashboardSourceEvidenceSchema>;
export type DashboardTestHistory = z.infer<typeof dashboardTestHistorySchema>;
export type DashboardProposalDetail = z.infer<typeof dashboardProposalDetailSchema>;
export type DashboardScoreDistribution = z.infer<typeof dashboardScoreDistributionSchema>;
export type DashboardRerunResult = z.infer<typeof dashboardRerunResultSchema>;
export type DashboardConnection = z.infer<typeof dashboardConnectionSchema>;
export type DashboardErrorCode = z.infer<typeof dashboardErrorCodeSchema>;
export type DashboardImportRequest = z.infer<typeof dashboardImportRequestSchema>;
export type DashboardMonitoringRequest = z.infer<typeof dashboardMonitoringRequestSchema>;
export type DashboardApplyRequest = z.infer<typeof dashboardApplyRequestSchema>;
export type DashboardImportResult = z.infer<typeof dashboardImportResultSchema>;
export type DashboardMonitoringResult = z.infer<typeof dashboardMonitoringResultSchema>;
export type DashboardScanResult = z.infer<typeof dashboardScanResultSchema>;
export type DashboardImproveResult = z.infer<typeof dashboardImproveResultSchema>;
export type DashboardProposalActionResult = z.infer<typeof dashboardProposalActionResultSchema>;
export type DashboardApplyResult = z.infer<typeof dashboardApplyResultSchema>;
export type DashboardRevertResult = z.infer<typeof dashboardRevertResultSchema>;
