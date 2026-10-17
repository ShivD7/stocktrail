import { z } from 'zod';

const timestampSchema = z.string().datetime({ offset: true });

export const dashboardIncidentStatusSchema = z.enum(['open', 'resolved', 'ignored']);
export const dashboardSeveritySchema = z.enum(['high', 'medium']);

export const dashboardOverviewSchema = z.object({
  shop: z.string().nullable(),
  monitoredProducts: z.object({
    selected: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  incidents: z.object({
    open: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    ignored: z.number().int().nonnegative(),
  }),
  latestScan: z.object({
    id: z.string().uuid(),
    productGid: z.string(),
    productTitle: z.string(),
    status: z.enum(['complete', 'partial']),
    completedAt: timestampSchema,
    readinessScore: z.number().int().min(0).max(100).nullable(),
  }).nullable(),
});

export const dashboardIncidentSummarySchema = z.object({
  id: z.string().uuid(),
  productGid: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
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
});

export const dashboardSourceEvidenceSchema = z.object({
  source: z.enum(['admin', 'ajax', 'html', 'jsonld', 'browser']),
  outcome: z.enum(['observed', 'inconclusive']),
  reasonCode: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  artifactPath: z.enum(['admin.json', 'ajax.json', 'html.html', 'jsonld.json', 'browser.json']).nullable(),
});

export const dashboardTestHistorySchema = z.object({
  runId: z.string().uuid(),
  outcome: z.enum(['pass', 'fail', 'inconclusive']),
  reasonCode: z.string(),
  completedAt: timestampSchema,
});

export const dashboardIncidentDetailSchema = dashboardIncidentSummarySchema.extend({
  productUrl: z.string().url().nullable(),
  latestEvidenceRunId: z.string().uuid(),
  sources: z.array(dashboardSourceEvidenceSchema),
  testHistory: z.array(dashboardTestHistorySchema),
});

export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;
export type DashboardIncidentSummary = z.infer<typeof dashboardIncidentSummarySchema>;
export type DashboardIncidentDetail = z.infer<typeof dashboardIncidentDetailSchema>;
export type DashboardSourceEvidence = z.infer<typeof dashboardSourceEvidenceSchema>;
export type DashboardTestHistory = z.infer<typeof dashboardTestHistorySchema>;
