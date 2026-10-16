import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTransientClaims,
  scoreInventorySearchReadiness,
} from '../dist/packages/scorer/src/readiness.js';

const runId = '11111111-1111-4111-8111-111111111111';
const productId = 'gid://shopify/Product/9000';
const variantId = 'gid://shopify/ProductVariant/9001';

function evaluation(ruleId, result = 'pass') {
  return {
    schemaVersion: 1, ruleVersion: 1, ruleId, productId, variantId, result,
    severity: ruleId === 'ST-001' ? 'medium' : 'high',
    reasonCode: `${ruleId.toLowerCase()}_${result}`,
    match: null,
    requiredSources: ruleId === 'ST-001' ? ['admin', 'jsonld'] : ['admin', 'browser'],
    evidenceRunId: runId,
    evaluatedAt: '2026-10-16T12:00:02.000Z',
  };
}

const match = {
  outcome: 'matched', variantId, legacyVariantId: '9001', method: 'variant_id',
  confidence: 'authoritative', corroboratingMethods: ['variant_id'],
};

const content = {
  title: 'Synthetic Trail Shoe',
  descriptionHtml: '<p>Durable synthetic fixture.</p>',
  seoTitle: 'Synthetic Trail Shoe',
  seoDescription: 'Synthetic fixture only.',
  productUpdatedAt: '2026-10-16T12:00:00.000Z',
  latestInventoryUpdatedAt: '2026-10-16T11:00:00.000Z',
};

function base(overrides = {}) {
  return {
    evaluations: [evaluation('ST-001'), evaluation('ST-002'), evaluation('ST-003', 'not_applicable')],
    matches: [match, match],
    structuredData: {
      sourceOutcome: 'observed', presence: 'present', malformedBlockCount: 0,
      variantOfferCount: 1, supportedAvailabilityCount: 1,
    },
    adminContent: content,
    ...overrides,
  };
}

test('readiness uses the exact 30/25/20/15/10 arithmetic', () => {
  const result = scoreInventorySearchReadiness(base());
  assert.equal(result.total, 100);
  assert.equal(result.knownPoints, 100);
  assert.equal(result.knownMax, 100);
  assert.deepEqual(result.components.map(value => value.weight), [30, 25, 20, 15, 10]);
  assert.match(result.limitation, /not an SEO ranking claim/);

  const failed = scoreInventorySearchReadiness(base({
    evaluations: [evaluation('ST-001', 'fail'), evaluation('ST-002'), evaluation('ST-003', 'not_applicable')],
    structuredData: { ...base().structuredData, presence: 'absent', variantOfferCount: 0, supportedAvailabilityCount: 0 },
  }));
  assert.equal(failed.total, 50);
  assert.deepEqual(failed.components.map(value => value.points), [0, 25, 0, 15, 10]);
});

test('inconclusive components produce a null total with known arithmetic', () => {
  const result = scoreInventorySearchReadiness(base({ matches: [] }));
  assert.equal(result.total, null);
  assert.equal(result.knownPoints, 75);
  assert.equal(result.knownMax, 75);
  assert.equal(result.components.find(value => value.id === 'variant_identity').points, null);
});

test('content checks are conservative, explainable, and stale-sensitive', () => {
  const risky = {
    ...content,
    descriptionHtml: '<p>In stock right now. Only 3 left. Restocks on Friday. Ships tomorrow.</p>',
    productUpdatedAt: '2026-10-16T10:00:00.000Z',
    latestInventoryUpdatedAt: '2026-10-16T11:00:00.000Z',
  };
  assert.deepEqual(detectTransientClaims(risky).map(value => value.code), [
    'in_stock_now', 'exact_quantity', 'unsupported_restock', 'unsupported_delivery',
  ]);
  const result = scoreInventorySearchReadiness(base({ adminContent: risky }));
  assert.equal(result.total, 75);
  assert.equal(result.components.find(value => value.id === 'inventory_promise_clarity').points, 0);
  assert.equal(result.components.find(value => value.id === 'stale_claim_safety').points, 0);

  const prose = detectTransientClaims({ ...content, descriptionHtml: '<p>Designed for delivery routes and stocked shelves.</p>' });
  assert.deepEqual(prose, []);
});
