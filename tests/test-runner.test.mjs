import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';

const entry = resolve('dist/apps/cli/src/index.js');
const shop = 'private-example.myshopify.com';
const productGid = 'gid://shopify/Product/8800';
const variantGid = 'gid://shopify/ProductVariant/8801';
const runId = '88888888-8888-4888-8888-888888888888';
const observedAt = '2026-10-16T12:00:00.000Z';

function readiness() {
  const definitions = [
    ['availability_agreement', 30, 'not_ready'], ['variant_identity', 25, 'ready'],
    ['structured_data_quality', 20, 'ready'], ['inventory_promise_clarity', 15, 'ready'],
    ['stale_claim_safety', 10, 'ready'],
  ];
  return {
    schemaVersion: 1, total: 70, knownPoints: 70, knownMax: 100,
    components: definitions.map(([id, weight, outcome]) => ({
      id, weight, outcome, points: outcome === 'ready' ? weight : 0,
      reasonCodes: ['synthetic'], evidenceRefs: [{ source: 'detector', field: 'synthetic' }],
    })),
    limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
  };
}

test('stocktrail test fails safely as explicit inconclusive without browser runtime or private output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-test-cli-'));
  const data = join(directory, 'private-data-path');
  await writeFile(join(directory, 'placeholder'), '');
  const repository = await openCatalogRepository(data);
  try {
    repository.importCatalog(shop, [{
      id: productGid, title: 'Private synthetic title', descriptionHtml: '<p>Private</p>',
      seo: { title: null, description: null }, handle: 'private-synthetic-handle', status: 'ACTIVE',
      updatedAt: observedAt, onlineStoreUrl: 'https://private.invalid/products/private',
      publishedToOnlineStore: true,
      variants: [{
        id: variantGid, legacyResourceId: '8801', sku: 'PRIVATE-SKU',
        selectedOptions: [{ name: 'Size', value: 'Secret' }], inventoryPolicy: 'DENY',
        inventoryQuantity: 0, sellableOnlineQuantity: 0, updatedAt: observedAt,
        inventoryItem: { tracked: true },
      }],
    }], true, { observedAt, evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10' });
    repository.recordEvidenceRun(shop, productGid, {
      runId, status: 'complete', startedAt: observedAt, completedAt: observedAt,
      sources: [{ source: 'admin', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 }],
      artifacts: [],
    });
    repository.recordDiagnosticResults(shop, productGid, {
      evidenceRunId: runId, evaluatedAt: observedAt, readiness: readiness(),
      evaluations: [{
        schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId: productGid,
        variantId: variantGid, result: 'fail', severity: 'medium',
        reasonCode: 'jsonld_in_stock_while_admin_unavailable', match: null,
        requiredSources: ['admin', 'jsonld'], evidenceRunId: runId, evaluatedAt: observedAt,
      }],
    });
  } finally {
    repository.close();
  }
  await writeFile(join(data, 'config.json'), JSON.stringify({ version: 1, shop }) + '\n');
  try {
    const result = spawnSync(process.execPath, [entry, 'test'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, STOCKTRAIL_HOME: data },
    });
    assert.equal(result.status, 3);
    assert.match(result.stdout, /INCONCLUSIVE ST-001 test 1/);
    assert.match(result.stdout, /browser_runtime_not_integrated/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-example|Private synthetic|private-synthetic|PRIVATE-SKU|gid:\/\/|private-data-path/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
