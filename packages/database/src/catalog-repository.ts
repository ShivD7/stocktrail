import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  catalogProvenanceSchema,
  type CatalogProduct,
  type CatalogProvenance,
} from '../../shared/src/catalog.js';

const DATABASE_FILE = 'stocktrail.sqlite';
export const MONITORED_PRODUCT_LIMIT = 10;

type CountRow = { count: number };

export type CatalogImportResult = {
  productCount: number;
  variantCount: number;
  deactivatedProductCount: number;
};

export type MonitoringSummary = {
  monitoredProductCount: number;
  activeMonitoredProductCount: number;
  limit: number;
};

export type MonitoringCandidate = {
  productGid: string;
  monitored: boolean;
  present: boolean;
};

type Migration = string | ((database: DatabaseSync) => void);

function addColumnIfMissing(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(existing => existing.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const migrations: Migration[] = [
  `
    CREATE TABLE shops (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE import_runs (
      id INTEGER PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      product_count INTEGER NOT NULL,
      variant_count INTEGER NOT NULL,
      full_snapshot INTEGER NOT NULL CHECK (full_snapshot IN (0, 1))
    );

    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      shopify_gid TEXT NOT NULL,
      title TEXT NOT NULL,
      description_html TEXT NOT NULL,
      seo_title TEXT,
      seo_description TEXT,
      handle TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DRAFT')),
      shopify_updated_at TEXT NOT NULL,
      online_store_url TEXT,
      published_to_online_store INTEGER NOT NULL CHECK (published_to_online_store IN (0, 1)),
      is_present INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
      last_seen_import_id INTEGER NOT NULL REFERENCES import_runs(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (shop_id, shopify_gid)
    );

    CREATE TABLE variants (
      id INTEGER PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      shopify_gid TEXT NOT NULL,
      legacy_resource_id TEXT NOT NULL,
      sku TEXT,
      selected_options_json TEXT NOT NULL,
      inventory_policy TEXT NOT NULL CHECK (inventory_policy IN ('DENY', 'CONTINUE')),
      inventory_quantity INTEGER,
      shopify_updated_at TEXT NOT NULL,
      inventory_tracked INTEGER NOT NULL CHECK (inventory_tracked IN (0, 1)),
      is_present INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
      last_seen_import_id INTEGER NOT NULL REFERENCES import_runs(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (shop_id, shopify_gid)
    );

    CREATE TABLE monitored_products (
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, product_id)
    );

    CREATE INDEX products_shop_present ON products(shop_id, is_present);
    CREATE INDEX variants_product_present ON variants(product_id, is_present);
    CREATE INDEX variants_shop_present ON variants(shop_id, is_present);

    CREATE TRIGGER monitored_products_limit
    BEFORE INSERT ON monitored_products
    WHEN (SELECT COUNT(*) FROM monitored_products WHERE shop_id = NEW.shop_id) >= 10
    BEGIN
      SELECT RAISE(ABORT, 'monitor_limit');
    END;
  `,
  `
    CREATE TABLE products_v2 (
      id INTEGER PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      shopify_gid TEXT NOT NULL,
      title TEXT NOT NULL,
      description_html TEXT NOT NULL,
      seo_title TEXT,
      seo_description TEXT,
      handle TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED')),
      shopify_updated_at TEXT NOT NULL,
      online_store_url TEXT,
      published_to_online_store INTEGER NOT NULL CHECK (published_to_online_store IN (0, 1)),
      is_present INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
      last_seen_import_id INTEGER NOT NULL REFERENCES import_runs(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (shop_id, shopify_gid)
    );

    CREATE TABLE variants_v2 (
      id INTEGER PRIMARY KEY,
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products_v2(id) ON DELETE CASCADE,
      shopify_gid TEXT NOT NULL,
      legacy_resource_id TEXT NOT NULL,
      sku TEXT,
      selected_options_json TEXT NOT NULL,
      inventory_policy TEXT NOT NULL CHECK (inventory_policy IN ('DENY', 'CONTINUE')),
      inventory_quantity INTEGER,
      shopify_updated_at TEXT NOT NULL,
      inventory_tracked INTEGER NOT NULL CHECK (inventory_tracked IN (0, 1)),
      is_present INTEGER NOT NULL DEFAULT 1 CHECK (is_present IN (0, 1)),
      last_seen_import_id INTEGER NOT NULL REFERENCES import_runs(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (shop_id, shopify_gid)
    );

    CREATE TABLE monitored_products_v2 (
      shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products_v2(id) ON DELETE CASCADE,
      selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, product_id)
    );

    INSERT INTO products_v2 (
      id, shop_id, shopify_gid, title, description_html, seo_title, seo_description,
      handle, status, shopify_updated_at, online_store_url, published_to_online_store,
      is_present, last_seen_import_id, created_at, updated_at
    ) SELECT
      id, shop_id, shopify_gid, title, description_html, seo_title, seo_description,
      handle, status, shopify_updated_at, online_store_url, published_to_online_store,
      is_present, last_seen_import_id, created_at, updated_at
    FROM products;
    INSERT INTO variants_v2 (
      id, shop_id, product_id, shopify_gid, legacy_resource_id, sku,
      selected_options_json, inventory_policy, inventory_quantity, shopify_updated_at,
      inventory_tracked, is_present, last_seen_import_id, created_at, updated_at
    ) SELECT
      id, shop_id, product_id, shopify_gid, legacy_resource_id, sku,
      selected_options_json, inventory_policy, inventory_quantity, shopify_updated_at,
      inventory_tracked, is_present, last_seen_import_id, created_at, updated_at
    FROM variants;
    INSERT INTO monitored_products_v2 (shop_id, product_id, selected_at)
    SELECT shop_id, product_id, selected_at FROM monitored_products;

    DROP TABLE monitored_products;
    DROP TABLE variants;
    DROP TABLE products;

    ALTER TABLE products_v2 RENAME TO products;
    ALTER TABLE variants_v2 RENAME TO variants;
    ALTER TABLE monitored_products_v2 RENAME TO monitored_products;

    CREATE INDEX products_shop_present ON products(shop_id, is_present);
    CREATE INDEX variants_product_present ON variants(product_id, is_present);
    CREATE INDEX variants_shop_present ON variants(shop_id, is_present);

    CREATE TRIGGER monitored_products_limit
    BEFORE INSERT ON monitored_products
    WHEN (SELECT COUNT(*) FROM monitored_products WHERE shop_id = NEW.shop_id) >= 10
    BEGIN
      SELECT RAISE(ABORT, 'monitor_limit');
    END;
  `,
  database => {
    addColumnIfMissing(database, 'import_runs', 'observed_at', 'TEXT');
    addColumnIfMissing(
      database,
      'import_runs',
      'evidence_source',
      "TEXT CHECK (evidence_source IS NULL OR evidence_source = 'shopify_admin_graphql')",
    );
    addColumnIfMissing(
      database,
      'import_runs',
      'api_version',
      "TEXT CHECK (api_version IS NULL OR api_version = '2026-10')",
    );
    addColumnIfMissing(database, 'variants', 'sellable_online_quantity', 'INTEGER');
  },
];

function count(statement: StatementSync, ...values: SQLInputValue[]): number {
  return Number((statement.get(...values) as CountRow).count);
}

export class CatalogRepository {
  constructor(private readonly database: DatabaseSync) {}

  migrate(): void {
    this.database.exec('PRAGMA foreign_keys = ON;');
    const currentVersion = Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (currentVersion > migrations.length) {
      throw new Error('The local database was created by a newer StockTrail version. Update StockTrail before continuing.');
    }
    for (const [index, sql] of migrations.entries()) {
      const version = index + 1;
      if (version <= currentVersion) continue;
      this.transaction(() => {
        if (typeof sql === 'string') this.database.exec(sql);
        else sql(this.database);
        this.database.exec(`PRAGMA user_version = ${version}`);
      });
    }
  }

  close(): void {
    this.database.close();
  }

  importCatalog(
    shop: string,
    products: CatalogProduct[],
    fullSnapshot: boolean,
    provenance: CatalogProvenance,
  ): CatalogImportResult {
    return this.transaction(() => {
      const parsedProvenance = catalogProvenanceSchema.safeParse(provenance);
      if (!parsedProvenance.success) throw new Error('Invalid catalog provenance.');
      this.database.prepare(`
        INSERT INTO shops (domain) VALUES (?)
        ON CONFLICT(domain) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      `).run(shop);
      const shopId = Number((this.database.prepare('SELECT id FROM shops WHERE domain = ?').get(shop) as { id: number }).id);
      const variantCount = products.reduce((total, product) => total + product.variants.length, 0);
      const importRun = this.database.prepare(`
        INSERT INTO import_runs (
          shop_id, product_count, variant_count, full_snapshot,
          observed_at, evidence_source, api_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        shopId,
        products.length,
        variantCount,
        fullSnapshot ? 1 : 0,
        parsedProvenance.data.observedAt,
        parsedProvenance.data.evidenceSource,
        parsedProvenance.data.apiVersion,
      );
      const importRunId = Number(importRun.lastInsertRowid);

      const upsertProduct = this.database.prepare(`
        INSERT INTO products (
          shop_id, shopify_gid, title, description_html, seo_title, seo_description,
          handle, status, shopify_updated_at, online_store_url,
          published_to_online_store, is_present, last_seen_import_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(shop_id, shopify_gid) DO UPDATE SET
          title = excluded.title,
          description_html = excluded.description_html,
          seo_title = excluded.seo_title,
          seo_description = excluded.seo_description,
          handle = excluded.handle,
          status = excluded.status,
          shopify_updated_at = excluded.shopify_updated_at,
          online_store_url = excluded.online_store_url,
          published_to_online_store = excluded.published_to_online_store,
          is_present = 1,
          last_seen_import_id = excluded.last_seen_import_id,
          updated_at = CURRENT_TIMESTAMP
      `);
      const upsertVariant = this.database.prepare(`
        INSERT INTO variants (
          shop_id, product_id, shopify_gid, legacy_resource_id, sku,
          selected_options_json, inventory_policy, inventory_quantity,
          sellable_online_quantity, shopify_updated_at, inventory_tracked,
          is_present, last_seen_import_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(shop_id, shopify_gid) DO UPDATE SET
          product_id = excluded.product_id,
          legacy_resource_id = excluded.legacy_resource_id,
          sku = excluded.sku,
          selected_options_json = excluded.selected_options_json,
          inventory_policy = excluded.inventory_policy,
          inventory_quantity = excluded.inventory_quantity,
          sellable_online_quantity = excluded.sellable_online_quantity,
          shopify_updated_at = excluded.shopify_updated_at,
          inventory_tracked = excluded.inventory_tracked,
          is_present = 1,
          last_seen_import_id = excluded.last_seen_import_id,
          updated_at = CURRENT_TIMESTAMP
      `);

      for (const product of products) {
        upsertProduct.run(
          shopId, product.id, product.title, product.descriptionHtml,
          product.seo.title, product.seo.description, product.handle, product.status,
          product.updatedAt, product.onlineStoreUrl, product.publishedToOnlineStore ? 1 : 0,
          importRunId,
        );
        const productId = Number((this.database.prepare(`
          SELECT id FROM products WHERE shop_id = ? AND shopify_gid = ?
        `).get(shopId, product.id) as { id: number }).id);
        for (const variant of product.variants) {
          upsertVariant.run(
            shopId, productId, variant.id, variant.legacyResourceId, variant.sku,
            JSON.stringify(variant.selectedOptions), variant.inventoryPolicy,
            variant.inventoryQuantity, variant.sellableOnlineQuantity,
            variant.updatedAt, variant.inventoryItem.tracked ? 1 : 0,
            importRunId,
          );
        }
        this.database.prepare(`
          UPDATE variants SET is_present = 0, updated_at = CURRENT_TIMESTAMP
          WHERE product_id = ? AND last_seen_import_id <> ? AND is_present = 1
        `).run(productId, importRunId);
      }

      let deactivatedProductCount = 0;
      if (fullSnapshot) {
        const deactivated = this.database.prepare(`
          UPDATE products SET is_present = 0, updated_at = CURRENT_TIMESTAMP
          WHERE shop_id = ? AND last_seen_import_id <> ? AND is_present = 1
        `).run(shopId, importRunId);
        deactivatedProductCount = Number(deactivated.changes);
        this.database.prepare(`
          UPDATE variants SET is_present = 0, updated_at = CURRENT_TIMESTAMP
          WHERE shop_id = ? AND last_seen_import_id <> ? AND is_present = 1
        `).run(shopId, importRunId);
      }

      return { productCount: products.length, variantCount, deactivatedProductCount };
    });
  }

  addMonitoredProduct(shop: string, productGid: string): MonitoringSummary {
    this.validateProductGid(productGid);
    return this.transaction(() => {
      const product = this.database.prepare(`
        SELECT products.id AS product_id, shops.id AS shop_id
        FROM products JOIN shops ON shops.id = products.shop_id
        WHERE shops.domain = ? AND products.shopify_gid = ? AND products.is_present = 1
      `).get(shop, productGid) as { product_id: number; shop_id: number } | undefined;
      if (!product) throw new Error('The product is not in the active local catalog. Run stocktrail import first.');
      const existing = count(this.database.prepare(`
        SELECT COUNT(*) AS count FROM monitored_products WHERE shop_id = ? AND product_id = ?
      `), product.shop_id, product.product_id);
      if (existing === 0) {
        const selected = count(this.database.prepare(`
          SELECT COUNT(*) AS count FROM monitored_products WHERE shop_id = ?
        `), product.shop_id);
        if (selected >= MONITORED_PRODUCT_LIMIT) {
          throw new Error(`At most ${MONITORED_PRODUCT_LIMIT} products can be monitored.`);
        }
        this.database.prepare(`
          INSERT INTO monitored_products (shop_id, product_id) VALUES (?, ?)
        `).run(product.shop_id, product.product_id);
      }
      return this.monitoringSummaryByShopId(product.shop_id);
    });
  }

  removeMonitoredProduct(shop: string, productGid: string): MonitoringSummary {
    this.validateProductGid(productGid);
    return this.transaction(() => {
      const shopRow = this.database.prepare('SELECT id FROM shops WHERE domain = ?').get(shop) as { id: number } | undefined;
      if (!shopRow) return { monitoredProductCount: 0, activeMonitoredProductCount: 0, limit: MONITORED_PRODUCT_LIMIT };
      this.database.prepare(`
        DELETE FROM monitored_products
        WHERE shop_id = ? AND product_id IN (
          SELECT id FROM products WHERE shop_id = ? AND shopify_gid = ?
        )
      `).run(shopRow.id, shopRow.id, productGid);
      return this.monitoringSummaryByShopId(Number(shopRow.id));
    });
  }

  monitoringSummary(shop: string): MonitoringSummary {
    const shopRow = this.database.prepare('SELECT id FROM shops WHERE domain = ?').get(shop) as { id: number } | undefined;
    return shopRow
      ? this.monitoringSummaryByShopId(Number(shopRow.id))
      : { monitoredProductCount: 0, activeMonitoredProductCount: 0, limit: MONITORED_PRODUCT_LIMIT };
  }

  monitoringCandidates(shop: string): MonitoringCandidate[] {
    return (this.database.prepare(`
      SELECT products.shopify_gid AS product_gid,
        CASE WHEN monitored_products.product_id IS NULL THEN 0 ELSE 1 END AS monitored,
        products.is_present AS present
      FROM products
      JOIN shops ON shops.id = products.shop_id
      LEFT JOIN monitored_products
        ON monitored_products.shop_id = products.shop_id
        AND monitored_products.product_id = products.id
      WHERE shops.domain = ?
        AND (products.is_present = 1 OR monitored_products.product_id IS NOT NULL)
      ORDER BY products.shopify_gid
    `).all(shop) as Array<{ product_gid: string; monitored: number; present: number }>).map(row => ({
      productGid: row.product_gid,
      monitored: row.monitored === 1,
      present: row.present === 1,
    }));
  }

  validateAdminEvidenceTarget(shop: string, productGid: string): void {
    this.validateProductGid(productGid);
    const product = this.database.prepare(`
      SELECT products.is_present AS present,
        CASE WHEN monitored_products.product_id IS NULL THEN 0 ELSE 1 END AS monitored
      FROM products
      JOIN shops ON shops.id = products.shop_id
      LEFT JOIN monitored_products
        ON monitored_products.shop_id = products.shop_id
        AND monitored_products.product_id = products.id
      WHERE shops.domain = ? AND products.shopify_gid = ?
    `).get(shop, productGid) as { present: number; monitored: number } | undefined;
    if (!product) {
      throw new Error('The product is not in the configured shop local catalog. Run stocktrail import first.');
    }
    if (product.present !== 1) {
      throw new Error('The selected product is inactive in the local catalog. Run stocktrail import first.');
    }
    if (product.monitored !== 1) {
      throw new Error('The selected product is not monitored. Use stocktrail monitor add first.');
    }
  }

  catalogCounts(shop: string): { products: number; variants: number; imports: number } {
    const row = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM products JOIN shops ON shops.id = products.shop_id
          WHERE shops.domain = ? AND products.is_present = 1) AS products,
        (SELECT COUNT(*) FROM variants JOIN shops ON shops.id = variants.shop_id
          WHERE shops.domain = ? AND variants.is_present = 1) AS variants,
        (SELECT COUNT(*) FROM import_runs JOIN shops ON shops.id = import_runs.shop_id
          WHERE shops.domain = ?) AS imports
    `).get(shop, shop, shop) as { products: number; variants: number; imports: number };
    return { products: Number(row.products), variants: Number(row.variants), imports: Number(row.imports) };
  }

  private monitoringSummaryByShopId(shopId: number): MonitoringSummary {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS monitored,
        SUM(CASE WHEN products.is_present = 1 THEN 1 ELSE 0 END) AS active
      FROM monitored_products
      JOIN products ON products.id = monitored_products.product_id
      WHERE monitored_products.shop_id = ?
    `).get(shopId) as { monitored: number; active: number | null };
    return {
      monitoredProductCount: Number(row.monitored),
      activeMonitoredProductCount: Number(row.active ?? 0),
      limit: MONITORED_PRODUCT_LIMIT,
    };
  }

  private validateProductGid(productGid: string): void {
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productGid)) {
      throw new Error('Product ID must be a Shopify Product GID.');
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

export async function openCatalogRepository(directory: string): Promise<CatalogRepository> {
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, DATABASE_FILE));
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const repository = new CatalogRepository(database);
  try {
    repository.migrate();
    return repository;
  } catch (error) {
    repository.close();
    throw error;
  }
}
