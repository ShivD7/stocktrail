import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  catalogProvenanceSchema,
  type CatalogProduct,
  type CatalogProvenance,
} from '../../shared/src/catalog.js';
import {
  ruleEvaluationSchema,
  type RegressionAssertion,
  type RuleEvaluation,
} from '../../shared/src/diagnostics.js';
import { readinessScoreSchema, type ReadinessScore } from '../../shared/src/readiness.js';

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

export type EvidenceRunMetadata = {
  runId: string;
  status: 'complete' | 'partial';
  startedAt: string;
  completedAt: string;
  sources: Array<{
    source: 'admin' | 'ajax' | 'html' | 'jsonld' | 'browser';
    outcome: 'observed' | 'inconclusive';
    reasonCode: string | null;
    status: number | null;
    contentType: string | null;
    itemCount: number;
  }>;
  artifacts: Array<{
    source: 'admin' | 'ajax' | 'html' | 'jsonld' | 'browser' | 'bundle';
    relativePath: string;
    mediaType: string;
    sha256: string;
    bytes: number;
  }>;
};

export type DiagnosticRecordInput = {
  evidenceRunId: string;
  evaluatedAt: string;
  evaluations: RuleEvaluation[];
  readiness: ReadinessScore;
};

export type StoredRegressionTest = {
  id: string;
  incidentId: string;
  productGid: string;
  assertion: RegressionAssertion;
};

export type RegressionTestResultInput = {
  testId: string;
  outcome: 'pass' | 'fail' | 'inconclusive';
  reasonCode: string;
  evidenceRunId?: string | null;
  evaluationId?: string | null;
};

export type RegressionTestRunSummary = {
  id: string;
  status: 'passed' | 'failed' | 'inconclusive';
  passed: number;
  failed: number;
  inconclusive: number;
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
  `
    CREATE TABLE IF NOT EXISTS evidence_runs (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      collection_status TEXT NOT NULL CHECK (collection_status IN ('complete', 'partial')),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      source_count INTEGER NOT NULL,
      observed_source_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS evidence_sources (
      run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('admin', 'ajax', 'html', 'jsonld')),
      outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'inconclusive')),
      reason_code TEXT,
      http_status INTEGER,
      content_type TEXT,
      item_count INTEGER NOT NULL,
      PRIMARY KEY (run_id, source)
    );

    CREATE TABLE IF NOT EXISTS evidence_artifacts (
      run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('admin', 'ajax', 'html', 'jsonld', 'bundle')),
      relative_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (run_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS evidence_runs_product_created ON evidence_runs(product_id, created_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS rule_evaluations (
      id TEXT PRIMARY KEY,
      evidence_run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      variant_gid TEXT NOT NULL,
      rule_id TEXT NOT NULL CHECK (rule_id IN ('ST-001', 'ST-002', 'ST-003')),
      rule_version INTEGER NOT NULL CHECK (rule_version = 1),
      result TEXT NOT NULL CHECK (result IN ('pass', 'fail', 'inconclusive', 'not_applicable')),
      severity TEXT NOT NULL CHECK (severity IN ('high', 'medium')),
      reason_code TEXT NOT NULL,
      match_method TEXT,
      match_confidence TEXT,
      evaluated_at TEXT NOT NULL,
      UNIQUE (evidence_run_id, variant_gid, rule_id)
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      variant_gid TEXT NOT NULL,
      rule_id TEXT NOT NULL CHECK (rule_id IN ('ST-001', 'ST-002', 'ST-003')),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'ignored')),
      severity TEXT NOT NULL CHECK (severity IN ('high', 'medium')),
      first_evaluation_id TEXT NOT NULL REFERENCES rule_evaluations(id),
      latest_evaluation_id TEXT NOT NULL REFERENCES rule_evaluations(id),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_evaluated_at TEXT NOT NULL,
      resolved_at TEXT,
      occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
      UNIQUE (product_id, variant_gid, rule_id)
    );

    CREATE TABLE IF NOT EXISTS regression_tests (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      variant_gid TEXT NOT NULL,
      rule_id TEXT NOT NULL CHECK (rule_id IN ('ST-001', 'ST-002', 'ST-003')),
      rule_version INTEGER NOT NULL CHECK (rule_version = 1),
      assertion_type TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      last_run_at TEXT
    );

    CREATE TABLE IF NOT EXISTS readiness_scores (
      evidence_run_id TEXT PRIMARY KEY REFERENCES evidence_runs(id) ON DELETE CASCADE,
      total INTEGER CHECK (total BETWEEN 0 AND 100),
      known_points INTEGER NOT NULL CHECK (known_points BETWEEN 0 AND 100),
      known_max INTEGER NOT NULL CHECK (known_max BETWEEN 0 AND 100)
    );

    CREATE TABLE IF NOT EXISTS readiness_components (
      evidence_run_id TEXT NOT NULL REFERENCES readiness_scores(evidence_run_id) ON DELETE CASCADE,
      component TEXT NOT NULL,
      weight INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ready', 'not_ready', 'inconclusive')),
      points INTEGER,
      reason_codes_json TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      PRIMARY KEY (evidence_run_id, component)
    );

    CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'inconclusive')),
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      passed_count INTEGER NOT NULL,
      failed_count INTEGER NOT NULL,
      inconclusive_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_results (
      test_run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
      test_id TEXT NOT NULL REFERENCES regression_tests(id) ON DELETE CASCADE,
      evidence_run_id TEXT REFERENCES evidence_runs(id) ON DELETE SET NULL,
      evaluation_id TEXT REFERENCES rule_evaluations(id) ON DELETE SET NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'inconclusive')),
      reason_code TEXT NOT NULL,
      PRIMARY KEY (test_run_id, test_id)
    );

    CREATE INDEX IF NOT EXISTS rule_evaluations_run ON rule_evaluations(evidence_run_id);
    CREATE INDEX IF NOT EXISTS incidents_status ON incidents(status, product_id);
    CREATE INDEX IF NOT EXISTS regression_tests_enabled ON regression_tests(enabled, product_id);
  `,
  `
    CREATE TABLE evidence_sources_v2 (
      run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('admin', 'ajax', 'html', 'jsonld', 'browser')),
      outcome TEXT NOT NULL CHECK (outcome IN ('observed', 'inconclusive')),
      reason_code TEXT,
      http_status INTEGER,
      content_type TEXT,
      item_count INTEGER NOT NULL,
      PRIMARY KEY (run_id, source)
    );

    INSERT INTO evidence_sources_v2 (
      run_id, source, outcome, reason_code, http_status, content_type, item_count
    ) SELECT
      run_id, source, outcome, reason_code, http_status, content_type, item_count
    FROM evidence_sources;

    CREATE TABLE evidence_artifacts_v2 (
      run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('admin', 'ajax', 'html', 'jsonld', 'browser', 'bundle')),
      relative_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (run_id, relative_path)
    );

    INSERT INTO evidence_artifacts_v2 (
      run_id, source, relative_path, media_type, sha256, bytes
    ) SELECT
      run_id, source, relative_path, media_type, sha256, bytes
    FROM evidence_artifacts;

    DROP TABLE evidence_sources;
    DROP TABLE evidence_artifacts;
    ALTER TABLE evidence_sources_v2 RENAME TO evidence_sources;
    ALTER TABLE evidence_artifacts_v2 RENAME TO evidence_artifacts;
  `,
];

function count(statement: StatementSync, ...values: SQLInputValue[]): number {
  return Number((statement.get(...values) as CountRow).count);
}

function assertionType(ruleId: RuleEvaluation['ruleId']): RegressionAssertion['assertionType'] {
  if (ruleId === 'ST-001') return 'admin_unavailable_not_jsonld_in_stock';
  if (ruleId === 'ST-002') return 'admin_unavailable_not_storefront_permitted';
  return 'admin_sellable_not_storefront_blocked';
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

  recordEvidenceRun(shop: string, productGid: string, metadata: EvidenceRunMetadata): void {
    this.validateProductGid(productGid);
    this.transaction(() => {
      const product = this.database.prepare(`
        SELECT products.id AS product_id
        FROM products JOIN shops ON shops.id = products.shop_id
        WHERE shops.domain = ? AND products.shopify_gid = ?
      `).get(shop, productGid) as { product_id: number } | undefined;
      if (!product) throw new Error('Cannot index evidence for an unknown product.');
      const observed = metadata.sources.filter(source => source.outcome === 'observed').length;
      this.database.prepare(`
        INSERT INTO evidence_runs (
          id, product_id, collection_status, started_at, completed_at,
          source_count, observed_source_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        metadata.runId, product.product_id, metadata.status, metadata.startedAt,
        metadata.completedAt, metadata.sources.length, observed,
      );
      const insertSource = this.database.prepare(`
        INSERT INTO evidence_sources (
          run_id, source, outcome, reason_code, http_status, content_type, item_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const source of metadata.sources) {
        insertSource.run(
          metadata.runId, source.source, source.outcome, source.reasonCode,
          source.status, source.contentType, source.itemCount,
        );
      }
      const insertArtifact = this.database.prepare(`
        INSERT INTO evidence_artifacts (
          run_id, source, relative_path, media_type, sha256, bytes
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of metadata.artifacts) {
        insertArtifact.run(
          metadata.runId, artifact.source, artifact.relativePath, artifact.mediaType,
          artifact.sha256, artifact.bytes,
        );
      }
    });
  }

  recordDiagnosticResults(
    shop: string,
    productGid: string,
    input: DiagnosticRecordInput,
  ): { incidentCount: number; regressionTestCount: number } {
    this.validateProductGid(productGid);
    const parsedEvaluations = input.evaluations.map(value => ruleEvaluationSchema.parse(value));
    const readiness = readinessScoreSchema.parse(input.readiness);
    return this.transaction(() => {
      const product = this.database.prepare(`
        SELECT products.id AS product_id
        FROM products JOIN shops ON shops.id = products.shop_id
        WHERE shops.domain = ? AND products.shopify_gid = ?
      `).get(shop, productGid) as { product_id: number } | undefined;
      if (!product) throw new Error('Cannot record diagnostics for an unknown product.');
      const run = this.database.prepare('SELECT id FROM evidence_runs WHERE id = ? AND product_id = ?')
        .get(input.evidenceRunId, product.product_id);
      if (!run) throw new Error('Cannot record diagnostics without matching evidence.');

      this.database.prepare(`
        INSERT INTO readiness_scores (evidence_run_id, total, known_points, known_max)
        VALUES (?, ?, ?, ?)
      `).run(input.evidenceRunId, readiness.total, readiness.knownPoints, readiness.knownMax);
      const insertComponent = this.database.prepare(`
        INSERT INTO readiness_components (
          evidence_run_id, component, weight, outcome, points,
          reason_codes_json, evidence_refs_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const component of readiness.components) {
        insertComponent.run(
          input.evidenceRunId, component.id, component.weight, component.outcome, component.points,
          JSON.stringify(component.reasonCodes), JSON.stringify(component.evidenceRefs),
        );
      }

      const insertEvaluation = this.database.prepare(`
        INSERT INTO rule_evaluations (
          id, evidence_run_id, product_id, variant_gid, rule_id, rule_version,
          result, severity, reason_code, match_method, match_confidence, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const evaluation of parsedEvaluations) {
        if (evaluation.productId !== productGid || evaluation.evidenceRunId !== input.evidenceRunId) {
          throw new Error('Diagnostic evaluation does not belong to the evidence run.');
        }
        const evaluationId = randomUUID();
        insertEvaluation.run(
          evaluationId, input.evidenceRunId, product.product_id, evaluation.variantId,
          evaluation.ruleId, evaluation.ruleVersion, evaluation.result, evaluation.severity,
          evaluation.reasonCode,
          evaluation.match?.outcome === 'matched' ? evaluation.match.method : null,
          evaluation.match?.outcome === 'matched' ? evaluation.match.confidence : null,
          evaluation.evaluatedAt,
        );
        const existing = this.database.prepare(`
          SELECT id, status FROM incidents
          WHERE product_id = ? AND variant_gid = ? AND rule_id = ?
        `).get(product.product_id, evaluation.variantId, evaluation.ruleId) as
          { id: string; status: 'open' | 'resolved' | 'ignored' } | undefined;

        if (evaluation.result === 'fail') {
          if (!existing) {
            const incidentId = randomUUID();
            this.database.prepare(`
              INSERT INTO incidents (
                id, product_id, variant_gid, rule_id, status, severity,
                first_evaluation_id, latest_evaluation_id, first_seen_at,
                last_seen_at, last_evaluated_at, resolved_at, occurrence_count
              ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL, 1)
            `).run(
              incidentId, product.product_id, evaluation.variantId, evaluation.ruleId,
              evaluation.severity, evaluationId, evaluationId, evaluation.evaluatedAt,
              evaluation.evaluatedAt, evaluation.evaluatedAt,
            );
            this.database.prepare(`
              INSERT INTO regression_tests (
                id, incident_id, product_id, variant_gid, rule_id, rule_version,
                assertion_type, enabled, created_at
              ) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)
            `).run(
              randomUUID(), incidentId, product.product_id, evaluation.variantId,
              evaluation.ruleId, assertionType(evaluation.ruleId), evaluation.evaluatedAt,
            );
          } else {
            this.database.prepare(`
              UPDATE incidents SET
                status = CASE WHEN status = 'ignored' THEN 'ignored' ELSE 'open' END,
                latest_evaluation_id = ?, last_seen_at = ?, last_evaluated_at = ?,
                resolved_at = CASE WHEN status = 'ignored' THEN resolved_at ELSE NULL END,
                occurrence_count = occurrence_count + 1
              WHERE id = ?
            `).run(evaluationId, evaluation.evaluatedAt, evaluation.evaluatedAt, existing.id);
            if (existing.status !== 'ignored') {
              this.database.prepare('UPDATE regression_tests SET enabled = 1 WHERE incident_id = ?')
                .run(existing.id);
            }
          }
        } else if (existing) {
          this.database.prepare(`
            UPDATE incidents SET latest_evaluation_id = ?, last_evaluated_at = ?
            WHERE id = ?
          `).run(evaluationId, evaluation.evaluatedAt, existing.id);
          if ((evaluation.result === 'pass' || evaluation.result === 'not_applicable') && existing.status === 'open') {
            this.database.prepare(`
              UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?
            `).run(evaluation.evaluatedAt, existing.id);
          }
        }
      }
      return {
        incidentCount: count(this.database.prepare('SELECT COUNT(*) AS count FROM incidents WHERE product_id = ?'), product.product_id),
        regressionTestCount: count(this.database.prepare('SELECT COUNT(*) AS count FROM regression_tests WHERE product_id = ?'), product.product_id),
      };
    });
  }

  listActiveRegressionTests(): StoredRegressionTest[] {
    const rows = this.database.prepare(`
      SELECT regression_tests.id, regression_tests.incident_id, regression_tests.variant_gid,
        regression_tests.rule_id, regression_tests.rule_version, regression_tests.assertion_type,
        products.shopify_gid AS product_gid
      FROM regression_tests
      JOIN incidents ON incidents.id = regression_tests.incident_id
      JOIN products ON products.id = regression_tests.product_id
      WHERE regression_tests.enabled = 1 AND incidents.status = 'open'
      ORDER BY products.shopify_gid, regression_tests.rule_id, regression_tests.variant_gid
    `).all() as Array<{
      id: string; incident_id: string; variant_gid: string; rule_id: RegressionAssertion['ruleId'];
      rule_version: 1; assertion_type: RegressionAssertion['assertionType']; product_gid: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      incidentId: row.incident_id,
      productGid: row.product_gid,
      assertion: {
        schemaVersion: 1,
        ruleVersion: row.rule_version,
        assertionType: row.assertion_type,
        ruleId: row.rule_id,
        productId: row.product_gid,
        variantId: row.variant_gid,
      },
    }));
  }

  recordRegressionTestRun(
    startedAt: string,
    completedAt: string,
    results: RegressionTestResultInput[],
  ): RegressionTestRunSummary {
    return this.transaction(() => {
      const passed = results.filter(value => value.outcome === 'pass').length;
      const failed = results.filter(value => value.outcome === 'fail').length;
      const inconclusive = results.filter(value => value.outcome === 'inconclusive').length;
      const status = failed > 0 ? 'failed' : inconclusive > 0 ? 'inconclusive' : 'passed';
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO test_runs (
          id, status, started_at, completed_at, passed_count, failed_count, inconclusive_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, status, startedAt, completedAt, passed, failed, inconclusive);
      const insertResult = this.database.prepare(`
        INSERT INTO test_results (
          test_run_id, test_id, evidence_run_id, evaluation_id, outcome, reason_code
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const result of results) {
        const test = this.database.prepare(`
          SELECT regression_tests.incident_id, incidents.status
          FROM regression_tests JOIN incidents ON incidents.id = regression_tests.incident_id
          WHERE regression_tests.id = ?
        `).get(result.testId) as { incident_id: string; status: string } | undefined;
        if (!test) throw new Error('Regression test no longer exists.');
        insertResult.run(
          id, result.testId, result.evidenceRunId ?? null, result.evaluationId ?? null,
          result.outcome, result.reasonCode,
        );
        this.database.prepare('UPDATE regression_tests SET last_run_at = ? WHERE id = ?')
          .run(completedAt, result.testId);
        if (test.status !== 'ignored') {
          if (result.outcome === 'pass') {
            this.database.prepare(`
              UPDATE incidents SET status = 'resolved', resolved_at = ?, last_evaluated_at = ?
              WHERE id = ? AND status = 'open'
            `).run(completedAt, completedAt, test.incident_id);
          } else if (result.outcome === 'fail') {
            this.database.prepare(`
              UPDATE incidents SET status = 'open', resolved_at = NULL, last_evaluated_at = ?
              WHERE id = ?
            `).run(completedAt, test.incident_id);
          }
        }
      }
      return { id, status, passed, failed, inconclusive };
    });
  }

  setIncidentStatus(incidentId: string, status: 'open' | 'resolved' | 'ignored'): void {
    this.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE incidents SET status = ?, resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END
        WHERE id = ?
      `).run(status, status, incidentId);
      if (Number(changed.changes) !== 1) throw new Error('Incident does not exist.');
      this.database.prepare('UPDATE regression_tests SET enabled = ? WHERE incident_id = ?')
        .run(status === 'open' ? 1 : 0, incidentId);
    });
  }

  diagnosticCounts(): { evaluations: number; incidents: number; tests: number; testRuns: number } {
    return {
      evaluations: count(this.database.prepare('SELECT COUNT(*) AS count FROM rule_evaluations')),
      incidents: count(this.database.prepare('SELECT COUNT(*) AS count FROM incidents')),
      tests: count(this.database.prepare('SELECT COUNT(*) AS count FROM regression_tests')),
      testRuns: count(this.database.prepare('SELECT COUNT(*) AS count FROM test_runs')),
    };
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
