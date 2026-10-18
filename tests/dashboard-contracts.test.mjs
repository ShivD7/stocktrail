import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardApplyRequestSchema,
  dashboardConnectionSchema,
  dashboardErrorSchema,
  dashboardIncidentDetailSchema,
  dashboardOverviewSchema,
  dashboardProductSummarySchema,
  dashboardProposalDetailSchema,
  dashboardRerunResultSchema,
} from '../dist/packages/shared/src/dashboard.js';

const scoreDistribution = {
  buckets: [
    { minimum: 0, maximum: 19, count: 0 },
    { minimum: 20, maximum: 39, count: 0 },
    { minimum: 40, maximum: 59, count: 0 },
    { minimum: 60, maximum: 79, count: 0 },
    { minimum: 80, maximum: 100, count: 0 },
  ],
  inconclusive: 0,
};

test('dashboard overview accepts an empty local state and rejects unknown fields', () => {
  const input = {
    shop: null,
    monitoredProducts: { selected: 0, active: 0, limit: 10 },
    incidents: { open: 0, resolved: 0, ignored: 0 },
    latestScan: null,
    scoreDistribution,
  };
  assert.equal(dashboardOverviewSchema.parse(input).latestScan, null);
  assert.equal(dashboardOverviewSchema.safeParse({ ...input, token: 'secret' }).success, false);
});

test('dashboard product and proposal contracts expose bounded display data', () => {
  const product = {
    productGid: 'gid://shopify/Product/9000', title: 'Synthetic product', status: 'ACTIVE',
    present: true, monitored: true, variantCount: 1,
    inventory: { sellableVariants: 0, unavailableVariants: 1, unknownVariants: 0 },
    latestScan: null, readinessScore: 70,
    weakestComponent: { id: 'availability_agreement', outcome: 'not_ready', points: 0, weight: 30 },
    openIncidentCount: 1, latestProposal: null,
    allowedActions: ['unmonitor', 'scan', 'improve'],
  };
  assert.equal(dashboardProductSummarySchema.parse(product).readinessScore, 70);

  const proposal = {
    id: '33333333-3333-4333-8333-333333333333', productGid: product.productGid,
    kind: 'improvement', parentProposalId: null, status: 'ready', verificationStatus: 'not_started',
    sourceEvidenceRunId: '22222222-2222-4222-8222-222222222222', verificationEvidenceRunId: null,
    changes: [{ field: 'title', before: 'Old', after: 'New', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), displayMode: 'text' }],
    diffs: [{ field: 'title', mode: 'word', parts: [{ kind: 'remove', value: 'Old' }, { kind: 'add', value: 'New' }], truncated: false }],
    validation: { valid: true, reasonCodes: [], warningCodes: [] },
    scores: { current: 70, predicted: 100, verified: null },
    createdAt: '2026-10-16T12:00:00.000Z', completedAt: null, allowedActions: ['reject', 'apply'],
  };
  assert.equal(dashboardProposalDetailSchema.parse(proposal).changes[0].displayMode, 'text');
  assert.equal(dashboardProposalDetailSchema.safeParse({ ...proposal, artifactPath: '../proposal.json' }).success, false);
});

test('dashboard connection contract never includes credential values or local paths', () => {
  const value = dashboardConnectionSchema.parse({
    shop: 'example.myshopify.com', configuration: 'ready', credentialStorage: 'stored',
    catalog: { products: 4, variants: 8, imports: 2 },
    monitoring: { selected: 2, active: 2, limit: 10 },
    localData: { evidenceRuns: 3, incidents: 1, testRuns: 2, retention: 'manual' },
  });
  assert.equal(value.credentialStorage, 'stored');
  assert.equal('token' in value, false);
  assert.equal('directory' in value, false);
});

test('dashboard action and error contracts are strict', () => {
  assert.deepEqual(dashboardApplyRequestSchema.parse({ confirmation: 'APPLY proposal', acknowledgeWarnings: true }), {
    confirmation: 'APPLY proposal', acknowledgeWarnings: true,
  });
  assert.equal(dashboardApplyRequestSchema.safeParse({ confirmation: 'APPLY proposal', extra: true }).success, false);
  assert.deepEqual(dashboardErrorSchema.parse({ error: 'invalid_origin' }), { error: 'invalid_origin' });
  assert.equal(dashboardErrorSchema.safeParse({ error: 'contains_private_path' }).success, false);
});

test('dashboard rerun results keep only aggregate test outcomes', () => {
  assert.deepEqual(dashboardRerunResultSchema.parse({
    status: 'failed', passed: 2, failed: 1, inconclusive: 0,
  }), { status: 'failed', passed: 2, failed: 1, inconclusive: 0 });
  assert.equal(dashboardRerunResultSchema.safeParse({ status: 'failed', failed: -1 }).success, false);
});

test('dashboard incident detail is sanitized and rejects non-local evidence paths', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    productGid: 'gid://shopify/Product/9000', productTitle: 'Synthetic product',
    variantGid: 'gid://shopify/ProductVariant/9001', variantLabel: 'Size: One',
    ruleId: 'ST-001', status: 'open', severity: 'medium',
    firstSeenAt: '2026-10-16T12:00:00.000Z', lastSeenAt: '2026-10-16T12:00:00.000Z',
    lastEvaluatedAt: '2026-10-16T12:00:00.000Z', occurrenceCount: 1,
    latestReasonCode: 'jsonld_in_stock_while_admin_unavailable',
    productUrl: 'https://example.invalid/products/synthetic',
    latestEvidenceRunId: '22222222-2222-4222-8222-222222222222',
    sources: [{ source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1, artifactPath: 'jsonld.json' }],
    comparison: [
      { perspective: 'admin', source: 'admin', outcome: 'observed', reasonCode: null, itemCount: 1 },
      { perspective: 'storefront', source: 'ajax', outcome: 'inconclusive', reasonCode: 'missing', itemCount: 0 },
      { perspective: 'search', source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1 },
    ],
    testHistory: [],
  };
  assert.equal(dashboardIncidentDetailSchema.parse(base).comparison.length, 3);
  assert.equal(dashboardIncidentDetailSchema.safeParse({
    ...base, sources: [{ ...base.sources[0], artifactPath: '../token.txt' }],
  }).success, false);
});
