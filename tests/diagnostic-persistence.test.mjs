import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';
import { evaluateStoredAssertion } from '../dist/packages/test-runner/src/index.js';

const shop = 'example.myshopify.com';
const productGid = 'gid://shopify/Product/9000';
const variantGid = 'gid://shopify/ProductVariant/9001';
const observedAt = '2026-10-16T12:00:00.000Z';

function product() {
  return {
    id: productGid, title: 'Synthetic title', descriptionHtml: '<p>Synthetic</p>',
    seo: { title: null, description: null }, handle: 'synthetic', status: 'ACTIVE',
    updatedAt: observedAt, onlineStoreUrl: 'https://synthetic.invalid/products/synthetic',
    publishedToOnlineStore: true,
    variants: [{
      id: variantGid, legacyResourceId: '9001', sku: 'SYNTH',
      selectedOptions: [{ name: 'Size', value: 'One' }], inventoryPolicy: 'DENY',
      inventoryQuantity: 0, sellableOnlineQuantity: 0, updatedAt: observedAt,
      inventoryItem: { tracked: true },
    }],
  };
}

function evidence(repository, runId) {
  repository.recordEvidenceRun(shop, productGid, {
    runId, status: 'complete', startedAt: observedAt, completedAt: '2026-10-16T12:00:01.000Z',
    sources: [{ source: 'admin', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 }],
    artifacts: [],
  });
}

function evaluation(runId, result, reasonCode) {
  return {
    schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId: productGid,
    variantId: variantGid, result, severity: 'medium', reasonCode,
    match: {
      outcome: 'matched', variantId: variantGid, legacyVariantId: '9001',
      method: 'variant_id', confidence: 'authoritative', corroboratingMethods: ['variant_id'],
    },
    requiredSources: ['admin', 'jsonld'], evidenceRunId: runId,
    evaluatedAt: '2026-10-16T12:00:02.000Z',
  };
}

function readiness(total = 70) {
  const values = [
    ['availability_agreement', 30, total === 100 ? 'ready' : 'not_ready'],
    ['variant_identity', 25, 'ready'], ['structured_data_quality', 20, 'ready'],
    ['inventory_promise_clarity', 15, 'ready'], ['stale_claim_safety', 10, 'ready'],
  ];
  const components = values.map(([id, weight, outcome]) => ({
    id, weight, outcome, points: outcome === 'ready' ? weight : 0,
    reasonCodes: ['synthetic_fixture'], evidenceRefs: [{ source: 'detector', field: 'synthetic' }],
  }));
  return {
    schemaVersion: 1, total, knownPoints: total, knownMax: 100, components,
    limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
  };
}

test('migration preserves Phase 2 data and incidents dedupe, resolve, reopen, and remain ignored', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-phase3-db-'));
  let repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product()], true, {
      observedAt, evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10',
    });
    repository.addMonitoredProduct(shop, productGid);
    const run1 = '11111111-1111-4111-8111-111111111111';
    evidence(repository, run1);
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: run1, evaluatedAt: observedAt,
      evaluations: [evaluation(run1, 'fail', 'jsonld_in_stock_while_admin_unavailable')],
      readiness: readiness(70),
    });
    assert.deepEqual(repository.diagnosticCounts(), { evaluations: 1, incidents: 1, tests: 1, testRuns: 0 });
    const [storedTest] = repository.listActiveRegressionTests();
    assert.equal(storedTest.assertion.assertionType, 'admin_unavailable_not_jsonld_in_stock');

    const run2 = '22222222-2222-4222-8222-222222222222';
    evidence(repository, run2);
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: run2, evaluatedAt: observedAt,
      evaluations: [evaluation(run2, 'fail', 'jsonld_in_stock_while_admin_unavailable')],
      readiness: readiness(70),
    });
    assert.deepEqual(repository.diagnosticCounts(), { evaluations: 2, incidents: 1, tests: 1, testRuns: 0 });
    assert.equal(repository.listActiveRegressionTests()[0].id, storedTest.id);

    const corrected = evaluation(run2, 'pass', 'jsonld_reports_unavailable');
    const execution = evaluateStoredAssertion(storedTest, [corrected], run2);
    assert.equal(execution.outcome, 'pass');
    const testRun = repository.recordRegressionTestRun(observedAt, '2026-10-16T12:00:03.000Z', [{
      testId: storedTest.id, outcome: execution.outcome, reasonCode: execution.reasonCode,
      evidenceRunId: execution.evidenceRunId,
    }]);
    assert.equal(testRun.status, 'passed');
    assert.equal(repository.listActiveRegressionTests().length, 0);

    const run3 = '33333333-3333-4333-8333-333333333333';
    evidence(repository, run3);
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: run3, evaluatedAt: observedAt,
      evaluations: [evaluation(run3, 'fail', 'jsonld_in_stock_while_admin_unavailable')],
      readiness: readiness(70),
    });
    assert.equal(repository.listActiveRegressionTests()[0].id, storedTest.id);

    const inspection = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    const incident = inspection.prepare('SELECT id, occurrence_count FROM incidents').get();
    inspection.close();
    assert.equal(incident.occurrence_count, 3);
    repository.setIncidentStatus(incident.id, 'ignored');

    const run4 = '44444444-4444-4444-8444-444444444444';
    evidence(repository, run4);
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: run4, evaluatedAt: observedAt,
      evaluations: [evaluation(run4, 'fail', 'jsonld_in_stock_while_admin_unavailable')],
      readiness: readiness(70),
    });
    assert.equal(repository.listActiveRegressionTests().length, 0);
    assert.deepEqual(repository.catalogCounts(shop), { products: 1, variants: 1, imports: 1 });
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('inconclusive evaluations neither create nor resolve incidents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-phase3-inconclusive-'));
  const repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product()], true, {
      observedAt, evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10',
    });
    const run = '55555555-5555-4555-8555-555555555555';
    evidence(repository, run);
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: run, evaluatedAt: observedAt,
      evaluations: [evaluation(run, 'inconclusive', 'jsonld_inconclusive')],
      readiness: {
        ...readiness(70), total: null, knownPoints: 70, knownMax: 70,
        components: readiness(70).components.map((value, index) => index === 0
          ? { ...value, outcome: 'inconclusive', points: null } : value),
      },
    });
    assert.deepEqual(repository.diagnosticCounts(), { evaluations: 1, incidents: 0, tests: 0, testRuns: 0 });
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
