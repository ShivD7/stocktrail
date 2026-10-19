import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';

const shop = 'example.myshopify.com';
const provenance = {
  observedAt: '2026-10-18T12:00:00.000Z',
  evidenceSource: 'shopify_admin_graphql',
  apiVersion: '2026-10',
};

function product(id) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Synthetic ${id}`,
    descriptionHtml: '<p>Synthetic fixture</p>',
    seo: { title: null, description: null },
    handle: `synthetic-${id}`,
    status: 'ACTIVE',
    updatedAt: '2026-10-18T12:00:00.000Z',
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
      updatedAt: '2026-10-18T12:00:00.000Z',
      inventoryItem: { tracked: true },
    }],
  };
}

test('scan schedules persist interval, due state, and deterministic active monitored targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-schedule-state-'));
  let repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product(2), product(1), product(3)], true, provenance);
    repository.addMonitoredProduct(shop, 'gid://shopify/Product/2');
    repository.addMonitoredProduct(shop, 'gid://shopify/Product/1');
    repository.addMonitoredProduct(shop, 'gid://shopify/Product/3');
    repository.importCatalog(shop, [product(2), product(1)], true, provenance);

    assert.deepEqual(repository.activeMonitoredProductGids(shop), [
      'gid://shopify/Product/1',
      'gid://shopify/Product/2',
    ]);
    assert.deepEqual(
      repository.configureScanSchedule(shop, 30, '2026-10-18T12:30:00.000Z'),
      {
        intervalMinutes: 30,
        nextDueAt: '2026-10-18T12:30:00.000Z',
        lastStartedAt: null,
        lastCompletedAt: null,
        activeRunId: null,
      },
    );
    repository.close();
    repository = await openCatalogRepository(directory);
    assert.equal(repository.scanSchedule(shop)?.intervalMinutes, 30);
    assert.equal(repository.scanSchedule(shop)?.nextDueAt, '2026-10-18T12:30:00.000Z');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('schedule claims prevent overlap and completion advances the next due time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-schedule-claim-'));
  const repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product(1)], true, provenance);
    repository.configureScanSchedule(shop, 15, '2026-10-18T12:15:00.000Z');
    assert.equal(repository.claimScanSchedule(shop, 'early', '2026-10-18T12:14:59.000Z', false), null);
    assert.equal(
      repository.claimScanSchedule(shop, 'run-one', '2026-10-18T12:15:00.000Z', false)?.activeRunId,
      'run-one',
    );
    assert.equal(repository.claimScanSchedule(shop, 'run-two', '2026-10-18T12:16:00.000Z', true), null);
    repository.abandonScanSchedule(shop, 'run-one');
    assert.equal(repository.scanSchedule(shop)?.activeRunId, null);

    repository.claimScanSchedule(shop, 'run-two', '2026-10-18T12:20:00.000Z', true);
    const completed = repository.completeScanSchedule(shop, 'run-two', '2026-10-18T12:21:00.000Z');
    assert.equal(completed.activeRunId, null);
    assert.equal(completed.lastStartedAt, '2026-10-18T12:20:00.000Z');
    assert.equal(completed.lastCompletedAt, '2026-10-18T12:21:00.000Z');
    assert.equal(completed.nextDueAt, '2026-10-18T12:36:00.000Z');
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persisted claims block live overlap and become recoverable at the stale boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-schedule-recovery-'));
  let repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product(1)], true, provenance);
    repository.configureScanSchedule(shop, 15, '2026-10-18T12:00:00.000Z');
    repository.claimScanSchedule(shop, 'crashed-run', '2026-10-18T12:00:00.000Z', true);
    repository.close();

    repository = await openCatalogRepository(directory);
    assert.equal(repository.claimScanSchedule(
      shop, 'too-soon', '2026-10-18T17:59:59.999Z', true, '2026-10-18T11:59:59.999Z',
    ), null);
    assert.equal(repository.claimScanSchedule(
      shop, 'recovered-run', '2026-10-18T18:00:00.000Z', true, '2026-10-18T12:00:00.000Z',
    )?.activeRunId, 'recovered-run');
    assert.throws(
      () => repository.completeScanSchedule(shop, 'crashed-run', '2026-10-18T18:00:01.000Z'),
      /not owned by this run/,
    );
    repository.completeScanSchedule(shop, 'recovered-run', '2026-10-18T18:01:00.000Z');
    assert.equal(repository.scanSchedule(shop)?.activeRunId, null);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
