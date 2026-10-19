import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';
import { runScheduledScans } from '../dist/packages/agent/src/scheduler.js';

const shop = 'example.myshopify.com';
const observedAt = '2026-10-18T12:00:00.000Z';

function product(id) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Synthetic ${id}`,
    descriptionHtml: '<p>Synthetic fixture</p>',
    seo: { title: null, description: null },
    handle: `synthetic-${id}`,
    status: 'ACTIVE',
    updatedAt: observedAt,
    onlineStoreUrl: null,
    publishedToOnlineStore: false,
    variants: [{
      id: `gid://shopify/ProductVariant/${id}`,
      legacyResourceId: String(id),
      sku: null,
      selectedOptions: [{ name: 'Size', value: 'One' }],
      inventoryPolicy: 'DENY',
      inventoryQuantity: 1,
      sellableOnlineQuantity: 1,
      updatedAt: observedAt,
      inventoryItem: { tracked: true },
    }],
  };
}

async function fixture(count = 3) {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-scheduler-run-'));
  const repository = await openCatalogRepository(directory);
  const products = Array.from({ length: count }, (_, index) => product(index + 1));
  repository.importCatalog(shop, products, true, {
    observedAt,
    evidenceSource: 'shopify_admin_graphql',
    apiVersion: '2026-10',
  });
  for (const value of products) repository.addMonitoredProduct(shop, value.id);
  repository.configureScanSchedule(shop, 30, '2026-10-18T12:00:00.000Z');
  repository.close();
  return directory;
}

function dependencies(scan, now = '2026-10-18T12:30:00.000Z') {
  return {
    async readConfig() { return { version: 1, shop }; },
    openRepository: openCatalogRepository,
    scan,
    now: () => new Date(now),
    uuid: () => 'scheduled-run',
  };
}

test('scheduled run scans each selected product and isolates product failures', async () => {
  const directory = await fixture();
  const calls = [];
  try {
    const result = await runScheduledScans(directory, {}, dependencies(async (_directory, productId, options) => {
      calls.push([productId, options]);
      if (productId.endsWith('/2')) throw new Error('Synthetic product failure');
    }));
    assert.deepEqual(result, {
      status: 'completed', selectedProductCount: 3, attemptedProductCount: 3,
      succeededProductCount: 2, failedProductCount: 1,
    });
    assert.deepEqual(calls.map(call => call[0]), [
      'gid://shopify/Product/1', 'gid://shopify/Product/2', 'gid://shopify/Product/3',
    ]);
    assert.ok(calls.every(call => call[1].browser === true && call[1].cartAdd === false));
    const repository = await openCatalogRepository(directory);
    assert.equal(repository.scanSchedule(shop).nextDueAt, '2026-10-18T13:00:00.000Z');
    repository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scheduled run reports not-due and overlapping claims without scanning', async () => {
  const directory = await fixture(1);
  let scans = 0;
  const deps = dependencies(async () => { scans += 1; }, '2026-10-18T11:59:59.000Z');
  try {
    assert.equal((await runScheduledScans(directory, {}, deps)).status, 'not_due');
    const repository = await openCatalogRepository(directory);
    repository.claimScanSchedule(shop, 'other-run', '2026-10-18T12:00:00.000Z', true);
    repository.close();
    assert.equal((await runScheduledScans(directory, { force: true }, deps)).status, 'already_running');
    assert.equal(scans, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancellation reaches the active scan and stops before the next product', async () => {
  const directory = await fixture();
  const controller = new AbortController();
  const receivedSignals = [];
  try {
    const result = await runScheduledScans(directory, { force: true, signal: controller.signal }, dependencies(
      async (_directory, _productId, options) => {
        receivedSignals.push(options.signal);
        controller.abort();
        throw new Error('Cancelled');
      },
    ));
    assert.deepEqual(result, {
      status: 'cancelled', selectedProductCount: 3, attemptedProductCount: 1,
      succeededProductCount: 0, failedProductCount: 0,
    });
    assert.deepEqual(receivedSignals, [controller.signal]);
    const repository = await openCatalogRepository(directory);
    assert.equal(repository.scanSchedule(shop).activeRunId, null);
    assert.equal(repository.scanSchedule(shop).nextDueAt, '2026-10-18T12:00:00.000Z');
    repository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
