import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';
import { runScheduledScans } from '../dist/packages/agent/src/scheduler.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/700';
const variantId = 'gid://shopify/ProductVariant/701';

const product = {
  id: productId,
  title: 'Synthetic fixture',
  descriptionHtml: '<p>Synthetic fixture</p>',
  seo: { title: null, description: null },
  handle: 'synthetic-fixture',
  status: 'ACTIVE',
  updatedAt: '2026-10-18T12:00:00.000Z',
  onlineStoreUrl: 'https://example.invalid/products/synthetic-fixture',
  publishedToOnlineStore: true,
  variants: [{
    id: variantId,
    legacyResourceId: '701',
    sku: null,
    selectedOptions: [{ name: 'Size', value: 'One' }],
    inventoryPolicy: 'DENY',
    inventoryQuantity: 0,
    sellableOnlineQuantity: 0,
    updatedAt: '2026-10-18T12:00:00.000Z',
    inventoryItem: { tracked: true },
  }],
};

function readiness() {
  return {
    schemaVersion: 1,
    total: 70,
    knownPoints: 70,
    knownMax: 100,
    components: [
      ['availability_agreement', 30, 'not_ready', 0],
      ['variant_identity', 25, 'ready', 25],
      ['structured_data_quality', 20, 'ready', 20],
      ['inventory_promise_clarity', 15, 'ready', 15],
      ['stale_claim_safety', 10, 'ready', 10],
    ].map(([id, weight, outcome, points]) => ({
      id, weight, outcome, points,
      reasonCodes: ['synthetic_fixture'],
      evidenceRefs: [{ source: 'detector', field: 'synthetic' }],
    })),
    limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
  };
}

test('repeated scheduled failures update one incident and its last-seen time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-schedule-incidents-'));
  let runNumber = 0;
  let clock = '2026-10-18T12:00:00.000Z';
  try {
    const repository = await openCatalogRepository(directory);
    repository.importCatalog(shop, [product], true, {
      observedAt: clock, evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10',
    });
    repository.addMonitoredProduct(shop, productId);
    repository.configureScanSchedule(shop, 30, clock);
    repository.claimScanSchedule(shop, 'interrupted-run', '2026-10-18T05:59:59.999Z', true);
    repository.close();

    const dependencies = {
      async readConfig() { return { version: 1, shop }; },
      openRepository: openCatalogRepository,
      now: () => new Date(clock),
      uuid: () => `schedule-${runNumber + 1}`,
      async scan() {
        runNumber += 1;
        const runId = `${String(runNumber).repeat(8)}-${String(runNumber).repeat(4)}-4${String(runNumber).repeat(3)}-8${String(runNumber).repeat(3)}-${String(runNumber).repeat(12)}`;
        const scanRepository = await openCatalogRepository(directory);
        try {
          scanRepository.recordEvidenceRun(shop, productId, {
            runId, status: 'complete', startedAt: clock, completedAt: clock,
            sources: [{ source: 'admin', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 }],
            artifacts: [],
          });
          scanRepository.recordDiagnosticResults(shop, productId, {
            evidenceRunId: runId,
            evaluatedAt: clock,
            evaluations: [{
              schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId,
              variantId, result: 'fail', severity: 'medium',
              reasonCode: 'jsonld_in_stock_while_admin_unavailable',
              match: {
                outcome: 'matched', variantId, legacyVariantId: '701', method: 'variant_id',
                confidence: 'authoritative', corroboratingMethods: ['variant_id'],
              },
              requiredSources: ['admin', 'jsonld'], evidenceRunId: runId, evaluatedAt: clock,
            }],
            readiness: readiness(),
          });
        } finally {
          scanRepository.close();
        }
      },
    };

    await runScheduledScans(directory, { force: true }, dependencies);
    clock = '2026-10-18T12:30:00.000Z';
    await runScheduledScans(directory, { force: true }, dependencies);

    const inspection = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    const incidents = inspection.prepare(`
      SELECT occurrence_count, first_seen_at, last_seen_at FROM incidents
    `).all().map(row => ({ ...row }));
    inspection.close();
    assert.deepEqual(incidents, [{
      occurrence_count: 2,
      first_seen_at: '2026-10-18T12:00:00.000Z',
      last_seen_at: '2026-10-18T12:30:00.000Z',
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
