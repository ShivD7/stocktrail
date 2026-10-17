import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MONITORED_PRODUCT_LIMIT,
  openCatalogRepository,
} from '../dist/packages/database/src/catalog-repository.js';

const shop = 'example.myshopify.com';
const provenance = {
  observedAt: '2026-10-15T12:00:00.000Z',
  evidenceSource: 'shopify_admin_graphql',
  apiVersion: '2026-10',
};

function product(number, variantNumbers = [number], overrides = {}) {
  return {
    id: `gid://shopify/Product/${number}`,
    title: `Synthetic product ${number}`,
    descriptionHtml: '<p>Synthetic description</p>',
    seo: { title: null, description: null },
    handle: `synthetic-${number}`,
    status: 'ACTIVE',
    updatedAt: '2026-10-01T00:00:00Z',
    onlineStoreUrl: null,
    publishedToOnlineStore: false,
    variants: variantNumbers.map(variantNumber => ({
      id: `gid://shopify/ProductVariant/${variantNumber}`,
      legacyResourceId: String(variantNumber),
      sku: null,
      selectedOptions: [{ name: 'Size', value: 'One' }],
      inventoryPolicy: 'DENY',
      inventoryQuantity: 1,
      sellableOnlineQuantity: 1,
      updatedAt: '2026-10-01T00:00:00Z',
      inventoryItem: { tracked: true },
    })),
    ...overrides,
  };
}

test('catalog imports are transactional, idempotent, and soft-stale complete snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-database-'));
  const repository = await openCatalogRepository(directory);
  try {
    repository.importCatalog(shop, [product(1, [11, 12]), product(2, [21])], true, provenance);
    assert.deepEqual(repository.catalogCounts(shop), { products: 2, variants: 3, imports: 1 });

    repository.importCatalog(shop, [
      product(1, [11, 12], { title: 'Synthetic updated product', status: 'UNLISTED' }),
      product(2, [21]),
    ], true, provenance);
    assert.deepEqual(repository.catalogCounts(shop), { products: 2, variants: 3, imports: 2 });
    const inspection = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    try {
      const updated = inspection.prepare(`
        SELECT title, status, COUNT(*) AS rows FROM products WHERE shopify_gid = ?
      `).get('gid://shopify/Product/1');
      assert.equal(updated.title, 'Synthetic updated product');
      assert.equal(updated.status, 'UNLISTED');
      assert.equal(updated.rows, 1);
    } finally {
      inspection.close();
    }

    repository.importCatalog(shop, [product(1, [11])], false, provenance);
    assert.deepEqual(repository.catalogCounts(shop), { products: 2, variants: 2, imports: 3 });

    const result = repository.importCatalog(shop, [product(1, [11])], true, provenance);
    assert.equal(result.deactivatedProductCount, 1);
    assert.deepEqual(repository.catalogCounts(shop), { products: 1, variants: 1, imports: 4 });

    const circularOptions = [];
    circularOptions.push(circularOptions);
    const invalid = product(3);
    invalid.variants[0].selectedOptions = circularOptions;
    assert.throws(() => repository.importCatalog(shop, [invalid], true, provenance), /circular/i);
    assert.deepEqual(repository.catalogCounts(shop), { products: 1, variants: 1, imports: 4 });

    const invalidObservedAtValues = [
      '2026-02-31T12:00:00.000Z',
      '2026-10-15T08:00:00-04:00',
      '2026-10-15T12:00:00Z',
      '2026-10-15T12:00:00.0000Z',
      'private-invalid-date',
    ];
    for (const invalidObservedAt of invalidObservedAtValues) {
      assert.throws(
        () => repository.importCatalog(shop, [product(3)], true, {
          ...provenance,
          observedAt: invalidObservedAt,
        }),
        error => {
          assert.equal(error.message, 'Invalid catalog provenance.');
          assert.doesNotMatch(error.message, new RegExp(invalidObservedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        },
      );
      assert.deepEqual(repository.catalogCounts(shop), { products: 1, variants: 1, imports: 4 });
    }
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('fresh imports persist safe provenance and sellable quantity while retaining inventory evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-provenance-'));
  const repository = await openCatalogRepository(directory);
  try {
    const imported = product(31, [311, 312]);
    imported.variants[0].inventoryQuantity = null;
    imported.variants[0].sellableOnlineQuantity = 0;
    imported.variants[1].inventoryQuantity = -7;
    imported.variants[1].sellableOnlineQuantity = -3;
    repository.importCatalog(shop, [imported], true, provenance);

    const inspection = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    try {
      const run = inspection.prepare(`
        SELECT observed_at, evidence_source, api_version FROM import_runs
      `).get();
      assert.deepEqual({ ...run }, {
        observed_at: provenance.observedAt,
        evidence_source: provenance.evidenceSource,
        api_version: provenance.apiVersion,
      });
      const variants = inspection.prepare(`
        SELECT inventory_quantity, sellable_online_quantity
        FROM variants ORDER BY legacy_resource_id
      `).all();
      assert.deepEqual(variants.map(row => ({ ...row })), [
        { inventory_quantity: null, sellable_online_quantity: 0 },
        { inventory_quantity: -7, sellable_online_quantity: -3 },
      ]);
    } finally {
      inspection.close();
    }
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('monitoring selection is idempotent, retained for absent products, and capped at ten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-monitoring-'));
  const repository = await openCatalogRepository(directory);
  try {
    const products = Array.from({ length: MONITORED_PRODUCT_LIMIT + 1 }, (_, index) => product(index + 1));
    repository.importCatalog(shop, products, true, provenance);
    for (let index = 1; index <= MONITORED_PRODUCT_LIMIT; index += 1) {
      repository.addMonitoredProduct(shop, `gid://shopify/Product/${index}`);
    }
    repository.addMonitoredProduct(shop, 'gid://shopify/Product/1');
    assert.deepEqual(repository.monitoringSummary(shop), {
      monitoredProductCount: 10,
      activeMonitoredProductCount: 10,
      limit: 10,
    });
    const candidates = repository.monitoringCandidates(shop);
    assert.equal(candidates.length, 11);
    assert.deepEqual(candidates[0], { productGid: 'gid://shopify/Product/1', monitored: true, present: true });
    assert.equal(JSON.stringify(candidates).includes('Synthetic product'), false);
    assert.throws(
      () => repository.addMonitoredProduct(shop, 'gid://shopify/Product/11'),
      /At most 10 products/,
    );

    repository.importCatalog(shop, products.slice(1), true, provenance);
    assert.deepEqual(repository.monitoringSummary(shop), {
      monitoredProductCount: 10,
      activeMonitoredProductCount: 9,
      limit: 10,
    });
    assert.deepEqual(repository.monitoringCandidates(shop)[0], {
      productGid: 'gid://shopify/Product/1',
      monitored: true,
      present: false,
    });
    repository.removeMonitoredProduct(shop, 'gid://shopify/Product/1');
    assert.equal(repository.monitoringSummary(shop).monitoredProductCount, 9);
    assert.throws(() => repository.addMonitoredProduct(shop, 'not-a-gid'), /Shopify Product GID/);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migration version and persisted schema contain no private transport columns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-schema-'));
  const repository = await openCatalogRepository(directory);
  repository.close();
  try {
    const database = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    const version = database.prepare('PRAGMA user_version').get().user_version;
    const tables = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL
    `).all().map(row => row.sql).join('\n');
    database.close();
    assert.equal(version, 7);
    assert.doesNotMatch(tables, /token|credential|request.?id|header|raw.?response|query.?cost/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects databases created by a newer StockTrail schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-newer-schema-'));
  const path = join(directory, 'stocktrail.sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version = 999');
  database.close();
  try {
    await assert.rejects(() => openCatalogRepository(directory), /newer StockTrail version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy migrations preserve catalog rows and monitoring relationships with nullable new evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-v2-migration-'));
  try {
    let repository = await openCatalogRepository(directory);
    repository.importCatalog(shop, [product(71)], true, provenance);
    repository.addMonitoredProduct(shop, 'gid://shopify/Product/71');
    repository.close();

    const database = new DatabaseSync(join(directory, 'stocktrail.sqlite'));
    database.exec(`
      UPDATE import_runs SET observed_at = NULL, evidence_source = NULL, api_version = NULL;
      PRAGMA user_version = 1;
    `);
    database.close();

    repository = await openCatalogRepository(directory);
    assert.deepEqual(repository.catalogCounts(shop), { products: 1, variants: 1, imports: 1 });
    assert.deepEqual(repository.monitoringSummary(shop), {
      monitoredProductCount: 1,
      activeMonitoredProductCount: 1,
      limit: 10,
    });
    repository.close();

    const inspection = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    try {
      const legacyRun = inspection.prepare(`
        SELECT observed_at, evidence_source, api_version FROM import_runs
      `).get();
      const legacyVariant = inspection.prepare(`
        SELECT sellable_online_quantity FROM variants
      `).get();
      assert.deepEqual(
        { ...legacyRun },
        { observed_at: null, evidence_source: null, api_version: null },
      );
      assert.equal(legacyVariant.sellable_online_quantity, null);
      assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 7);
    } finally {
      inspection.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
