import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';

const shop = 'example.myshopify.com';
const productGid = 'gid://shopify/Product/9000';
const variantGid = 'gid://shopify/ProductVariant/9001';
const observedAt = '2026-10-16T12:00:00.000Z';
const runId = '11111111-1111-4111-8111-111111111111';

function product() {
  return {
    id: productGid, title: 'Synthetic trail shoe', descriptionHtml: '<p>Synthetic</p>',
    seo: { title: null, description: null }, handle: 'synthetic-trail-shoe', status: 'ACTIVE',
    updatedAt: observedAt, onlineStoreUrl: 'https://example.invalid/products/synthetic-trail-shoe',
    publishedToOnlineStore: true,
    variants: [{
      id: variantGid, legacyResourceId: '9001', sku: 'SYNTH-10',
      selectedOptions: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: '10' }],
      inventoryPolicy: 'DENY', inventoryQuantity: 0, sellableOnlineQuantity: 0,
      updatedAt: observedAt, inventoryItem: { tracked: true },
    }],
  };
}

function evaluation() {
  return {
    schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId: productGid,
    variantId: variantGid, result: 'fail', severity: 'medium',
    reasonCode: 'jsonld_in_stock_while_admin_unavailable',
    match: {
      outcome: 'matched', variantId: variantGid, legacyVariantId: '9001',
      method: 'variant_id', confidence: 'authoritative', corroboratingMethods: ['variant_id'],
    },
    requiredSources: ['admin', 'jsonld'], evidenceRunId: runId,
    evaluatedAt: '2026-10-16T12:00:02.000Z',
  };
}

function readiness() {
  const rows = [
    ['availability_agreement', 30, 'not_ready'], ['variant_identity', 25, 'ready'],
    ['structured_data_quality', 20, 'ready'], ['inventory_promise_clarity', 15, 'ready'],
    ['stale_claim_safety', 10, 'ready'],
  ];
  return {
    schemaVersion: 1, total: 70, knownPoints: 70, knownMax: 100,
    components: rows.map(([id, weight, outcome]) => ({
      id, weight, outcome, points: outcome === 'ready' ? weight : 0,
      reasonCodes: ['synthetic_fixture'], evidenceRefs: [{ source: 'detector', field: 'synthetic' }],
    })),
    limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
  };
}

test('dashboard read model returns overview, incident evidence, and test history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-dashboard-repository-'));
  const repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product()], true, {
      observedAt, evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10',
    });
    repository.addMonitoredProduct(shop, productGid);
    repository.recordEvidenceRun(shop, productGid, {
      runId, status: 'complete', startedAt: observedAt, completedAt: '2026-10-16T12:00:01.000Z',
      sources: [
        { source: 'admin', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 },
        { source: 'jsonld', outcome: 'observed', reasonCode: null, status: 200, contentType: 'text/html', itemCount: 1 },
      ],
      artifacts: [
        { source: 'admin', relativePath: 'admin.json', mediaType: 'application/json', sha256: 'a'.repeat(64), bytes: 42 },
        { source: 'jsonld', relativePath: 'jsonld.json', mediaType: 'application/json', sha256: 'b'.repeat(64), bytes: 37 },
      ],
    });
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: runId, evaluatedAt: observedAt,
      evaluations: [evaluation()], readiness: readiness(),
    });

    const overview = repository.dashboardOverview(shop);
    assert.equal(overview.monitoredProducts.active, 1);
    assert.equal(overview.incidents.open, 1);
    assert.equal(overview.latestScan.productTitle, 'Synthetic trail shoe');
    assert.equal(overview.latestScan.readinessScore, 70);

    const [incident] = repository.listDashboardIncidents(shop, 'open');
    assert.equal(incident.variantLabel, 'Color: Red / Size: 10');
    assert.equal(incident.latestReasonCode, 'jsonld_in_stock_while_admin_unavailable');

    const [regression] = repository.listActiveRegressionTests();
    repository.recordRegressionTestRun(observedAt, '2026-10-16T12:00:03.000Z', [{
      testId: regression.id, outcome: 'fail', reasonCode: 'still_in_stock', evidenceRunId: runId,
    }]);
    const detail = repository.dashboardIncident(shop, incident.id);
    assert.equal(detail.sources.length, 2);
    assert.equal(detail.sources[1].artifactPath, 'jsonld.json');
    assert.equal(detail.testHistory[0].outcome, 'fail');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('dashboard read model keeps an unconfigured store empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-dashboard-empty-'));
  const repository = await openCatalogRepository(directory);
  try {
    const overview = repository.dashboardOverview(null);
    assert.equal(overview.shop, null);
    assert.equal(overview.latestScan, null);
    assert.deepEqual(repository.listDashboardIncidents(shop), []);
    assert.equal(repository.dashboardIncident(shop, '11111111-1111-4111-8111-111111111111'), null);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
