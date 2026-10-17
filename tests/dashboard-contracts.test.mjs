import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dashboardIncidentDetailSchema,
  dashboardOverviewSchema,
  dashboardRerunResultSchema,
} from '../dist/packages/shared/src/dashboard.js';

test('dashboard overview accepts an empty local state', () => {
  const value = dashboardOverviewSchema.parse({
    shop: null,
    monitoredProducts: { selected: 0, active: 0, limit: 10 },
    incidents: { open: 0, resolved: 0, ignored: 0 },
    latestScan: null,
  });
  assert.equal(value.latestScan, null);
});

test('dashboard rerun results keep only aggregate test outcomes', () => {
  assert.deepEqual(dashboardRerunResultSchema.parse({
    status: 'failed', passed: 2, failed: 1, inconclusive: 0,
  }), { status: 'failed', passed: 2, failed: 1, inconclusive: 0 });
  assert.equal(dashboardRerunResultSchema.safeParse({ status: 'failed', failed: -1 }).success, false);
});

test('dashboard incident detail rejects non-local evidence paths', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    productGid: 'gid://shopify/Product/9000',
    productTitle: 'Synthetic product',
    variantGid: 'gid://shopify/ProductVariant/9001',
    variantLabel: 'Size: One',
    ruleId: 'ST-001',
    status: 'open',
    severity: 'medium',
    firstSeenAt: '2026-10-16T12:00:00.000Z',
    lastSeenAt: '2026-10-16T12:00:00.000Z',
    lastEvaluatedAt: '2026-10-16T12:00:00.000Z',
    occurrenceCount: 1,
    latestReasonCode: 'jsonld_in_stock_while_admin_unavailable',
    productUrl: 'https://example.invalid/products/synthetic',
    latestEvidenceRunId: '22222222-2222-4222-8222-222222222222',
    sources: [{
      source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1,
      artifactPath: 'jsonld.json',
    }],
    testHistory: [],
  };
  assert.equal(dashboardIncidentDetailSchema.parse(base).sources.length, 1);
  assert.equal(dashboardIncidentDetailSchema.safeParse({
    ...base,
    sources: [{ ...base.sources[0], artifactPath: '../token.txt' }],
  }).success, false);
});
