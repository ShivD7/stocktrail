import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
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
import type {
  ProposalArtifact,
  ProposalKind,
  ProposalStatus,
  ProposalVerificationStatus,
} from '../../shared/src/proposals.js';
import {
  dashboardIncidentDetailSchema,
  dashboardIncidentSummarySchema,
  dashboardOverviewSchema,
  dashboardProductDetailSchema,
  dashboardProductSummarySchema,
  dashboardScoreDistributionSchema,
  type DashboardIncidentDetail,
  type DashboardIncidentSummary,
  type DashboardOverview,
  type DashboardProductDetail,
  type DashboardProductSummary,
  type DashboardScoreDistribution,
} from '../../shared/src/dashboard.js';

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

export type ScanSchedule = {
  intervalMinutes: number;
  nextDueAt: string;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  activeRunId: string | null;
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

export type LatestProposalEvidence = {
  evidenceRunId: string;
  completedAt: string;
  adminArtifactSha256: string;
  readiness: ReadinessScore;
};

export type ProposalArtifactIndex = {
  role: 'proposal' | 'before' | 'candidate' | 'diff' | 'mutation_response' | 'reconciled_admin';
  relativePath: string;
  mediaType: string;
  sha256: string;
  bytes: number;
};

export type StoredProposal = {
  id: string;
  productGid: string;
  kind: ProposalKind;
  parentProposalId: string | null;
  status: ProposalStatus;
  verificationStatus: ProposalVerificationStatus;
  sourceEvidenceRunId: string;
  verificationEvidenceRunId: string | null;
  currentScore: number | null;
  predictedScore: number | null;
  verifiedScore: number | null;
  changedFields: string[];
  warningCodes: string[];
  createdAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  proposalArtifactSha256: string;
  proposalArtifactBytes: number;
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
  `
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('improvement', 'revert')),
      parent_proposal_id TEXT REFERENCES proposals(id) ON DELETE RESTRICT,
      source_evidence_run_id TEXT NOT NULL REFERENCES evidence_runs(id) ON DELETE RESTRICT,
      verification_evidence_run_id TEXT REFERENCES evidence_runs(id) ON DELETE SET NULL,
      base_fingerprint TEXT NOT NULL,
      candidate_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'ready', 'rejected', 'approved', 'applying', 'stale',
        'not_applied', 'ambiguous', 'applied'
      )),
      verification_status TEXT NOT NULL CHECK (verification_status IN (
        'not_started', 'pending', 'verified', 'failed', 'inconclusive', 'drifted'
      )),
      current_readiness_json TEXT NOT NULL,
      predicted_readiness_json TEXT NOT NULL,
      validation_codes_json TEXT NOT NULL,
      warning_codes_json TEXT NOT NULL,
      rule_version INTEGER NOT NULL CHECK (rule_version = 1),
      created_at TEXT NOT NULL,
      approved_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS proposal_fields (
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      field TEXT NOT NULL CHECK (field IN ('title', 'descriptionHtml', 'seo.title', 'seo.description')),
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      rule_codes_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      PRIMARY KEY (proposal_id, field)
    );

    CREATE TABLE IF NOT EXISTS proposal_events (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proposal_write_attempts (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('candidate', 'base', 'ambiguous', 'unreadable')),
      error_codes_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS proposal_artifacts (
      proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN (
        'proposal', 'before', 'candidate', 'diff', 'mutation_response', 'reconciled_admin'
      )),
      relative_path TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type = 'application/json'),
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (proposal_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS proposals_product_created ON proposals(product_id, created_at);
    CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, verification_status);
    CREATE INDEX IF NOT EXISTS proposal_events_proposal_created ON proposal_events(proposal_id, created_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS scan_schedules (
      shop_id INTEGER PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
      interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 10080),
      next_due_at TEXT NOT NULL,
      last_started_at TEXT,
      last_completed_at TEXT,
      active_run_id TEXT
    );
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

function productDescriptionText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 100_000);
}

function variantLabel(selectedOptions: unknown, sku: unknown, variantGid: unknown): string {
  try {
    const options = JSON.parse(String(selectedOptions)) as unknown;
    if (Array.isArray(options)) {
      const labels = options.flatMap(option => {
        if (!option || typeof option !== 'object') return [];
        const value = option as { name?: unknown; value?: unknown };
        return typeof value.name === 'string' && typeof value.value === 'string'
          ? [`${value.name}: ${value.value}`]
          : [];
      });
      if (labels.length > 0) return labels.join(' / ');
    }
  } catch {
    // A damaged label must not make the local dashboard unavailable.
  }
  if (typeof sku === 'string' && sku.trim()) return `SKU ${sku}`;
  const suffix = typeof variantGid === 'string' ? variantGid.split('/').at(-1) : null;
  return suffix ? `Variant ${suffix}` : 'Unknown variant';
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

  activeMonitoredProductGids(shop: string): string[] {
    return (this.database.prepare(`
      SELECT products.shopify_gid AS product_gid
      FROM monitored_products
      JOIN products ON products.id = monitored_products.product_id
        AND products.shop_id = monitored_products.shop_id
      JOIN shops ON shops.id = monitored_products.shop_id
      WHERE shops.domain = ? AND products.is_present = 1
      ORDER BY products.shopify_gid
      LIMIT ?
    `).all(shop, MONITORED_PRODUCT_LIMIT) as Array<{ product_gid: string }>)
      .map(row => row.product_gid);
  }

  configureScanSchedule(shop: string, intervalMinutes: number, nextDueAt: string): ScanSchedule {
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10_080) {
      throw new Error('Schedule interval must be a whole number from 1 to 10080 minutes.');
    }
    this.validateTimestamp(nextDueAt, 'Schedule next-due time');
    const shopRow = this.database.prepare('SELECT id FROM shops WHERE domain = ?').get(shop) as
      { id: number } | undefined;
    if (!shopRow) throw new Error('Cannot schedule scans before importing the configured shop.');
    this.database.prepare(`
      INSERT INTO scan_schedules (shop_id, interval_minutes, next_due_at)
      VALUES (?, ?, ?)
      ON CONFLICT(shop_id) DO UPDATE SET
        interval_minutes = excluded.interval_minutes,
        next_due_at = excluded.next_due_at
    `).run(shopRow.id, intervalMinutes, nextDueAt);
    return this.scanSchedule(shop)!;
  }

  scanSchedule(shop: string): ScanSchedule | null {
    const row = this.database.prepare(`
      SELECT scan_schedules.interval_minutes, scan_schedules.next_due_at,
        scan_schedules.last_started_at, scan_schedules.last_completed_at,
        scan_schedules.active_run_id
      FROM scan_schedules
      JOIN shops ON shops.id = scan_schedules.shop_id
      WHERE shops.domain = ?
    `).get(shop) as {
      interval_minutes: number;
      next_due_at: string;
      last_started_at: string | null;
      last_completed_at: string | null;
      active_run_id: string | null;
    } | undefined;
    return row ? {
      intervalMinutes: Number(row.interval_minutes),
      nextDueAt: row.next_due_at,
      lastStartedAt: row.last_started_at,
      lastCompletedAt: row.last_completed_at,
      activeRunId: row.active_run_id,
    } : null;
  }

  claimScanSchedule(shop: string, runId: string, startedAt: string, force: boolean): ScanSchedule | null {
    if (!runId.trim()) throw new Error('Schedule run ID cannot be empty.');
    this.validateTimestamp(startedAt, 'Schedule start time');
    return this.transaction(() => {
      const schedule = this.scanSchedule(shop);
      if (!schedule) throw new Error('No scan schedule is configured.');
      if (schedule.activeRunId !== null) return null;
      if (!force && Date.parse(schedule.nextDueAt) > Date.parse(startedAt)) return null;
      const updated = this.database.prepare(`
        UPDATE scan_schedules SET active_run_id = ?, last_started_at = ?
        WHERE shop_id = (SELECT id FROM shops WHERE domain = ?)
          AND active_run_id IS NULL
      `).run(runId, startedAt, shop);
      return Number(updated.changes) === 1 ? this.scanSchedule(shop) : null;
    });
  }

  completeScanSchedule(shop: string, runId: string, completedAt: string): ScanSchedule {
    this.validateTimestamp(completedAt, 'Schedule completion time');
    return this.transaction(() => {
      const schedule = this.scanSchedule(shop);
      if (!schedule || schedule.activeRunId !== runId) {
        throw new Error('The scheduled scan is not owned by this run.');
      }
      const nextDueAt = new Date(Date.parse(completedAt) + schedule.intervalMinutes * 60_000).toISOString();
      this.database.prepare(`
        UPDATE scan_schedules SET
          active_run_id = NULL, last_completed_at = ?, next_due_at = ?
        WHERE shop_id = (SELECT id FROM shops WHERE domain = ?) AND active_run_id = ?
      `).run(completedAt, nextDueAt, shop, runId);
      return this.scanSchedule(shop)!;
    });
  }

  abandonScanSchedule(shop: string, runId: string): void {
    this.database.prepare(`
      UPDATE scan_schedules SET active_run_id = NULL
      WHERE shop_id = (SELECT id FROM shops WHERE domain = ?) AND active_run_id = ?
    `).run(shop, runId);
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

  activeRegressionTestForIncident(shop: string, incidentId: string): StoredRegressionTest | null {
    const row = this.database.prepare(`
      SELECT regression_tests.id, regression_tests.incident_id, regression_tests.variant_gid,
        regression_tests.rule_id, regression_tests.rule_version, regression_tests.assertion_type,
        products.shopify_gid AS product_gid
      FROM regression_tests
      JOIN incidents ON incidents.id = regression_tests.incident_id
      JOIN products ON products.id = regression_tests.product_id
      JOIN shops ON shops.id = products.shop_id
      WHERE shops.domain = ? AND incidents.id = ?
        AND regression_tests.enabled = 1 AND incidents.status = 'open'
      LIMIT 1
    `).get(shop, incidentId) as {
      id: string; incident_id: string; variant_gid: string; rule_id: RegressionAssertion['ruleId'];
      rule_version: 1; assertion_type: RegressionAssertion['assertionType']; product_gid: string;
    } | undefined;
    return row ? {
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
    } : null;
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

  dashboardDataCounts(shop: string): { evidenceRuns: number; incidents: number; testRuns: number } {
    return {
      evidenceRuns: count(this.database.prepare(`
        SELECT COUNT(*) AS count FROM evidence_runs
        JOIN products ON products.id = evidence_runs.product_id
        JOIN shops ON shops.id = products.shop_id WHERE shops.domain = ?
      `), shop),
      incidents: count(this.database.prepare(`
        SELECT COUNT(*) AS count FROM incidents
        JOIN products ON products.id = incidents.product_id
        JOIN shops ON shops.id = products.shop_id WHERE shops.domain = ?
      `), shop),
      testRuns: count(this.database.prepare(`
        SELECT COUNT(DISTINCT test_runs.id) AS count FROM test_runs
        JOIN test_results ON test_results.test_run_id = test_runs.id
        JOIN regression_tests ON regression_tests.id = test_results.test_id
        JOIN products ON products.id = regression_tests.product_id
        JOIN shops ON shops.id = products.shop_id WHERE shops.domain = ?
      `), shop),
    };
  }

  dashboardOverview(shop: string | null): DashboardOverview {
    if (!shop) {
      return dashboardOverviewSchema.parse({
        shop: null,
        monitoredProducts: { selected: 0, active: 0, limit: MONITORED_PRODUCT_LIMIT },
        incidents: { open: 0, resolved: 0, ignored: 0 },
        latestScan: null,
        scoreDistribution: {
          buckets: [[0, 19], [20, 39], [40, 59], [60, 79], [80, 100]].map(([minimum, maximum]) => ({ minimum, maximum, count: 0 })),
          inconclusive: 0,
        },
      });
    }
    const monitored = this.monitoringSummary(shop);
    const incidentCounts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN incidents.status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN incidents.status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count,
        SUM(CASE WHEN incidents.status = 'ignored' THEN 1 ELSE 0 END) AS ignored_count
      FROM incidents
      JOIN products ON products.id = incidents.product_id
      JOIN shops ON shops.id = products.shop_id
      WHERE shops.domain = ?
    `).get(shop) as { open_count: number | null; resolved_count: number | null; ignored_count: number | null };
    const latest = this.database.prepare(`
      SELECT evidence_runs.id, products.shopify_gid AS product_gid, products.title,
        evidence_runs.collection_status, evidence_runs.completed_at, readiness_scores.total
      FROM evidence_runs
      JOIN products ON products.id = evidence_runs.product_id
      JOIN shops ON shops.id = products.shop_id
      LEFT JOIN readiness_scores ON readiness_scores.evidence_run_id = evidence_runs.id
      WHERE shops.domain = ?
      ORDER BY evidence_runs.completed_at DESC, evidence_runs.id DESC
      LIMIT 1
    `).get(shop) as Record<string, unknown> | undefined;
    return dashboardOverviewSchema.parse({
      shop,
      monitoredProducts: {
        selected: monitored.monitoredProductCount,
        active: monitored.activeMonitoredProductCount,
        limit: monitored.limit,
      },
      incidents: {
        open: Number(incidentCounts.open_count ?? 0),
        resolved: Number(incidentCounts.resolved_count ?? 0),
        ignored: Number(incidentCounts.ignored_count ?? 0),
      },
      latestScan: latest ? {
        id: latest.id,
        productGid: latest.product_gid,
        productTitle: latest.title,
        status: latest.collection_status,
        completedAt: latest.completed_at,
        readinessScore: latest.total,
      } : null,
      scoreDistribution: this.dashboardScoreDistribution(shop),
    });
  }

  dashboardProducts(shop: string): DashboardProductSummary[] {
    const rows = this.database.prepare(`
      SELECT products.id, products.shopify_gid, products.title, products.status,
        products.is_present,
        CASE WHEN monitored_products.product_id IS NULL THEN 0 ELSE 1 END AS monitored,
        COUNT(variants.id) AS variant_count,
        SUM(CASE WHEN variants.sellable_online_quantity > 0 THEN 1 ELSE 0 END) AS sellable_count,
        SUM(CASE WHEN variants.sellable_online_quantity <= 0 THEN 1 ELSE 0 END) AS unavailable_count,
        SUM(CASE WHEN variants.id IS NOT NULL AND variants.sellable_online_quantity IS NULL THEN 1 ELSE 0 END) AS unknown_count
      FROM products
      JOIN shops ON shops.id = products.shop_id
      LEFT JOIN monitored_products ON monitored_products.product_id = products.id
        AND monitored_products.shop_id = products.shop_id
      LEFT JOIN variants ON variants.product_id = products.id AND variants.is_present = 1
      WHERE shops.domain = ?
      GROUP BY products.id
      ORDER BY products.title COLLATE NOCASE, products.shopify_gid
    `).all(shop) as Array<Record<string, unknown>>;
    return rows.map(row => {
      const productId = Number(row.id);
      const latest = this.database.prepare(`
        SELECT evidence_runs.id, evidence_runs.collection_status, evidence_runs.completed_at,
          readiness_scores.total
        FROM evidence_runs
        LEFT JOIN readiness_scores ON readiness_scores.evidence_run_id = evidence_runs.id
        WHERE evidence_runs.product_id = ?
        ORDER BY evidence_runs.completed_at DESC, evidence_runs.id DESC LIMIT 1
      `).get(productId) as Record<string, unknown> | undefined;
      const weakest = latest ? this.database.prepare(`
        SELECT component, outcome, points, weight FROM readiness_components
        WHERE evidence_run_id = ?
        ORDER BY CASE outcome WHEN 'not_ready' THEN 0 WHEN 'inconclusive' THEN 1 ELSE 2 END,
          CASE WHEN points IS NULL THEN -1.0 ELSE CAST(points AS REAL) / weight END,
          weight DESC, component
        LIMIT 1
      `).get(String(latest.id)) as Record<string, unknown> | undefined : undefined;
      const openIncidentCount = count(this.database.prepare(`
        SELECT COUNT(*) AS count FROM incidents WHERE product_id = ? AND status = 'open'
      `), productId);
      const proposal = this.latestProposalForProduct(shop, String(row.shopify_gid));
      const monitored = Number(row.monitored) === 1;
      const present = Number(row.is_present) === 1;
      const allowedActions: DashboardProductSummary['allowedActions'] = [];
      if (present) allowedActions.push(monitored ? 'unmonitor' : 'monitor');
      if (present && monitored) allowedActions.push('scan');
      if (latest?.total !== null && latest?.total !== undefined) allowedActions.push('improve');
      if (proposal) allowedActions.push('view_proposal');
      return dashboardProductSummarySchema.parse({
        productGid: row.shopify_gid,
        title: row.title,
        status: row.status,
        present,
        monitored,
        variantCount: Number(row.variant_count),
        inventory: {
          sellableVariants: Number(row.sellable_count ?? 0),
          unavailableVariants: Number(row.unavailable_count ?? 0),
          unknownVariants: Number(row.unknown_count ?? 0),
        },
        latestScan: latest ? {
          id: latest.id,
          status: latest.collection_status,
          completedAt: latest.completed_at,
        } : null,
        readinessScore: latest?.total ?? null,
        weakestComponent: weakest ? {
          id: weakest.component,
          outcome: weakest.outcome,
          points: weakest.points,
          weight: weakest.weight,
        } : null,
        openIncidentCount,
        latestProposal: proposal ? {
          id: proposal.id,
          kind: proposal.kind,
          status: proposal.status,
          verificationStatus: proposal.verificationStatus,
          currentScore: proposal.currentScore,
          predictedScore: proposal.predictedScore,
          verifiedScore: proposal.verifiedScore,
          createdAt: proposal.createdAt,
        } : null,
        allowedActions,
      });
    });
  }

  dashboardProduct(shop: string, productGid: string): DashboardProductDetail | null {
    this.validateProductGid(productGid);
    const summary = this.dashboardProducts(shop).find(value => value.productGid === productGid);
    if (!summary) return null;
    const row = this.database.prepare(`
      SELECT products.description_html, products.seo_title, products.seo_description,
        products.online_store_url
      FROM products JOIN shops ON shops.id = products.shop_id
      WHERE shops.domain = ? AND products.shopify_gid = ?
    `).get(shop, productGid) as {
      description_html: string; seo_title: string | null; seo_description: string | null;
      online_store_url: string | null;
    } | undefined;
    if (!row) return null;
    return dashboardProductDetailSchema.parse({
      ...summary,
      productUrl: row.online_store_url,
      descriptionText: productDescriptionText(row.description_html),
      seo: { title: row.seo_title, description: row.seo_description },
      readiness: summary.latestScan ? this.readinessForRun(summary.latestScan.id) : null,
    });
  }

  dashboardScoreDistribution(shop: string): DashboardScoreDistribution {
    const rows = this.database.prepare(`
      WITH ranked AS (
        SELECT products.id AS product_id, readiness_scores.total,
          ROW_NUMBER() OVER (
            PARTITION BY products.id
            ORDER BY evidence_runs.completed_at DESC, evidence_runs.id DESC
          ) AS rank
        FROM products
        JOIN shops ON shops.id = products.shop_id
        LEFT JOIN evidence_runs ON evidence_runs.product_id = products.id
        LEFT JOIN readiness_scores ON readiness_scores.evidence_run_id = evidence_runs.id
        WHERE shops.domain = ?
      )
      SELECT total FROM ranked WHERE rank = 1
    `).all(shop) as Array<{ total: number | null }>;
    const ranges = [[0, 19], [20, 39], [40, 59], [60, 79], [80, 100]] as const;
    return dashboardScoreDistributionSchema.parse({
      buckets: ranges.map(([minimum, maximum]) => ({
        minimum,
        maximum,
        count: rows.filter(row => row.total !== null && row.total >= minimum && row.total <= maximum).length,
      })),
      inconclusive: rows.filter(row => row.total === null).length,
    });
  }

  listDashboardIncidents(shop: string, status?: 'open' | 'resolved' | 'ignored'): DashboardIncidentSummary[] {
    const rows = this.database.prepare(`
      SELECT incidents.id, products.shopify_gid AS product_gid, products.title,
        incidents.variant_gid, variants.selected_options_json, variants.sku,
        incidents.rule_id, incidents.status, incidents.severity, incidents.first_seen_at,
        incidents.last_seen_at, incidents.last_evaluated_at, incidents.occurrence_count,
        rule_evaluations.reason_code
      FROM incidents
      JOIN products ON products.id = incidents.product_id
      JOIN shops ON shops.id = products.shop_id
      JOIN rule_evaluations ON rule_evaluations.id = incidents.latest_evaluation_id
      LEFT JOIN variants ON variants.product_id = products.id
        AND variants.shopify_gid = incidents.variant_gid
      WHERE shops.domain = ? AND (? IS NULL OR incidents.status = ?)
      ORDER BY
        CASE incidents.status WHEN 'open' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END,
        incidents.last_seen_at DESC,
        incidents.id
    `).all(shop, status ?? null, status ?? null) as Array<Record<string, unknown>>;
    return rows.map(row => dashboardIncidentSummarySchema.parse({
      id: row.id,
      productGid: row.product_gid,
      productTitle: row.title,
      variantGid: row.variant_gid,
      variantLabel: variantLabel(row.selected_options_json, row.sku, row.variant_gid),
      ruleId: row.rule_id,
      status: row.status,
      severity: row.severity,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastEvaluatedAt: row.last_evaluated_at,
      occurrenceCount: row.occurrence_count,
      latestReasonCode: row.reason_code,
    }));
  }

  dashboardIncident(shop: string, incidentId: string): DashboardIncidentDetail | null {
    const summary = this.listDashboardIncidents(shop).find(value => value.id === incidentId);
    if (!summary) return null;
    const row = this.database.prepare(`
      SELECT products.online_store_url, rule_evaluations.evidence_run_id
      FROM incidents
      JOIN products ON products.id = incidents.product_id
      JOIN shops ON shops.id = products.shop_id
      JOIN rule_evaluations ON rule_evaluations.id = incidents.latest_evaluation_id
      WHERE shops.domain = ? AND incidents.id = ?
    `).get(shop, incidentId) as { online_store_url: string | null; evidence_run_id: string };
    const sources = (this.database.prepare(`
      SELECT evidence_sources.source, evidence_sources.outcome, evidence_sources.reason_code,
        evidence_sources.item_count, evidence_artifacts.relative_path
      FROM evidence_sources
      LEFT JOIN evidence_artifacts ON evidence_artifacts.run_id = evidence_sources.run_id
        AND evidence_artifacts.source = evidence_sources.source
      WHERE evidence_sources.run_id = ?
      ORDER BY CASE evidence_sources.source
        WHEN 'admin' THEN 0 WHEN 'ajax' THEN 1 WHEN 'browser' THEN 2
        WHEN 'jsonld' THEN 3 ELSE 4 END
    `).all(row.evidence_run_id) as Array<Record<string, unknown>>).map(source => ({
      source: source.source,
      outcome: source.outcome,
      reasonCode: source.reason_code,
      itemCount: source.item_count,
      artifactPath: source.relative_path ?? null,
    }));
    const testHistory = (this.database.prepare(`
      SELECT test_runs.id AS run_id, test_results.outcome, test_results.reason_code,
        test_runs.completed_at
      FROM regression_tests
      JOIN test_results ON test_results.test_id = regression_tests.id
      JOIN test_runs ON test_runs.id = test_results.test_run_id
      WHERE regression_tests.incident_id = ?
      ORDER BY test_runs.completed_at DESC, test_runs.id DESC
      LIMIT 20
    `).all(incidentId) as Array<Record<string, unknown>>).map(history => ({
      runId: history.run_id,
      outcome: history.outcome,
      reasonCode: history.reason_code,
      completedAt: history.completed_at,
    }));
    const perspective = (
      name: 'admin' | 'storefront' | 'search',
      candidates: Array<'admin' | 'ajax' | 'jsonld' | 'browser'>,
    ) => {
      const source = candidates.map(candidate => sources.find(value => value.source === candidate)).find(Boolean);
      return source ? {
        perspective: name,
        source: source.source,
        outcome: source.outcome,
        reasonCode: source.reasonCode,
        itemCount: source.itemCount,
      } : {
        perspective: name,
        source: null,
        outcome: 'inconclusive',
        reasonCode: 'source_unavailable',
        itemCount: 0,
      };
    };
    return dashboardIncidentDetailSchema.parse({
      ...summary,
      productUrl: row.online_store_url,
      latestEvidenceRunId: row.evidence_run_id,
      sources,
      comparison: [
        perspective('admin', ['admin']),
        perspective('storefront', ['browser', 'ajax']),
        perspective('search', ['jsonld']),
      ],
      testHistory,
    });
  }

  dashboardEvidenceArtifact(
    shop: string,
    runId: string,
    relativePath: 'admin.json' | 'ajax.json' | 'html.html' | 'jsonld.json' | 'browser.json',
  ): { relativePath: string; mediaType: string; sha256: string; bytes: number } | null {
    const row = this.database.prepare(`
      SELECT evidence_artifacts.relative_path, evidence_artifacts.media_type,
        evidence_artifacts.sha256, evidence_artifacts.bytes
      FROM evidence_artifacts
      JOIN evidence_runs ON evidence_runs.id = evidence_artifacts.run_id
      JOIN products ON products.id = evidence_runs.product_id
      JOIN shops ON shops.id = products.shop_id
      WHERE shops.domain = ? AND evidence_runs.id = ? AND evidence_artifacts.relative_path = ?
    `).get(shop, runId, relativePath) as {
      relative_path: string; media_type: string; sha256: string; bytes: number;
    } | undefined;
    return row ? {
      relativePath: row.relative_path,
      mediaType: row.media_type,
      sha256: row.sha256,
      bytes: Number(row.bytes),
    } : null;
  }

  latestProposalEvidence(shop: string, productGid: string): LatestProposalEvidence | null {
    this.validateProductGid(productGid);
    const row = this.database.prepare(`
      SELECT evidence_runs.id, evidence_runs.completed_at, evidence_artifacts.sha256,
        readiness_scores.total, readiness_scores.known_points, readiness_scores.known_max
      FROM evidence_runs
      JOIN products ON products.id = evidence_runs.product_id
      JOIN shops ON shops.id = products.shop_id
      JOIN readiness_scores ON readiness_scores.evidence_run_id = evidence_runs.id
      JOIN evidence_artifacts ON evidence_artifacts.run_id = evidence_runs.id
        AND evidence_artifacts.source = 'admin' AND evidence_artifacts.relative_path = 'admin.json'
      WHERE shops.domain = ? AND products.shopify_gid = ?
        AND EXISTS (
          SELECT 1 FROM evidence_sources
          WHERE evidence_sources.run_id = evidence_runs.id AND evidence_sources.source = 'browser'
        )
      ORDER BY evidence_runs.completed_at DESC, evidence_runs.id DESC
      LIMIT 1
    `).get(shop, productGid) as {
      id: string; completed_at: string; sha256: string;
      total: number | null; known_points: number; known_max: number;
    } | undefined;
    if (!row) return null;
    const componentRows = this.database.prepare(`
      SELECT component, weight, outcome, points, reason_codes_json, evidence_refs_json
      FROM readiness_components WHERE evidence_run_id = ? ORDER BY rowid
    `).all(row.id) as Array<{
      component: ReadinessScore['components'][number]['id'];
      weight: ReadinessScore['components'][number]['weight'];
      outcome: ReadinessScore['components'][number]['outcome'];
      points: number | null; reason_codes_json: string; evidence_refs_json: string;
    }>;
    const readiness = readinessScoreSchema.parse({
      schemaVersion: 1,
      total: row.total,
      knownPoints: row.known_points,
      knownMax: row.known_max,
      components: componentRows.map(component => ({
        id: component.component,
        weight: component.weight,
        outcome: component.outcome,
        points: component.points,
        reasonCodes: JSON.parse(component.reason_codes_json) as unknown,
        evidenceRefs: JSON.parse(component.evidence_refs_json) as unknown,
      })),
      limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
    });
    return { evidenceRunId: row.id, completedAt: row.completed_at, adminArtifactSha256: row.sha256, readiness };
  }

  recordProposal(shop: string, proposal: ProposalArtifact, artifacts: ProposalArtifactIndex[]): void {
    this.transaction(() => {
      const product = this.database.prepare(`
        SELECT products.id AS product_id FROM products
        JOIN shops ON shops.id = products.shop_id
        WHERE shops.domain = ? AND products.shopify_gid = ?
      `).get(shop, proposal.productId) as { product_id: number } | undefined;
      if (!product) throw new Error('Cannot save a proposal for an unknown product.');
      const run = this.database.prepare('SELECT id FROM evidence_runs WHERE id = ? AND product_id = ?')
        .get(proposal.sourceEvidenceRunId, product.product_id);
      if (!run) throw new Error('Cannot save a proposal without its source evidence.');
      const candidateFingerprint = createHash('sha256').update(JSON.stringify(proposal.candidate), 'utf8').digest('hex');
      this.database.prepare(`
        INSERT INTO proposals (
          id, product_id, kind, parent_proposal_id, source_evidence_run_id,
          base_fingerprint, candidate_fingerprint, status, verification_status,
          current_readiness_json, predicted_readiness_json, validation_codes_json,
          warning_codes_json, rule_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'not_started', ?, ?, ?, ?, 1, ?)
      `).run(
        proposal.id, product.product_id, proposal.kind, proposal.parentProposalId,
        proposal.sourceEvidenceRunId, proposal.base.fingerprint, candidateFingerprint,
        JSON.stringify(proposal.currentReadiness), JSON.stringify(proposal.predictedReadiness),
        JSON.stringify(proposal.validation.reasonCodes), JSON.stringify(proposal.validation.warningCodes),
        proposal.createdAt,
      );
      const fieldStatement = this.database.prepare(`
        INSERT INTO proposal_fields (
          proposal_id, field, before_hash, after_hash, rule_codes_json, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const change of proposal.changes) fieldStatement.run(
        proposal.id, change.field, change.beforeHash, change.afterHash,
        JSON.stringify(change.ruleCodes), JSON.stringify(change.provenance),
      );
      this.insertProposalArtifacts(proposal.id, artifacts);
      this.insertProposalEvent(proposal.id, 'created', proposal.createdAt, {
        kind: proposal.kind, changedFields: proposal.changes.map(change => change.field),
      });
      this.insertProposalEvent(proposal.id, 'validated', proposal.createdAt, {
        warnings: proposal.validation.warningCodes,
      });
    });
  }

  addProposalArtifacts(proposalId: string, artifacts: ProposalArtifactIndex[]): void {
    this.transaction(() => this.insertProposalArtifacts(proposalId, artifacts));
  }

  getProposalForShop(shop: string, proposalId: string): StoredProposal | null {
    const row = this.database.prepare(`
      SELECT proposals.*, products.shopify_gid,
        (SELECT sha256 FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_sha256,
        (SELECT bytes FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_bytes,
        (SELECT total FROM readiness_scores
          WHERE readiness_scores.evidence_run_id = proposals.verification_evidence_run_id) AS verified_score
      FROM proposals
      JOIN products ON products.id = proposals.product_id
      JOIN shops ON shops.id = products.shop_id
      WHERE shops.domain = ? AND proposals.id = ?
    `).get(shop, proposalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const fields = this.database.prepare('SELECT field FROM proposal_fields WHERE proposal_id = ? ORDER BY field')
      .all(proposalId) as Array<{ field: string }>;
    return this.storedProposal(row, fields.map(value => value.field));
  }

  latestProposalForProduct(shop: string, productGid: string): StoredProposal | null {
    const row = this.database.prepare(`
      SELECT proposals.*, products.shopify_gid,
        (SELECT sha256 FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_sha256,
        (SELECT bytes FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_bytes,
        (SELECT total FROM readiness_scores
          WHERE readiness_scores.evidence_run_id = proposals.verification_evidence_run_id) AS verified_score
      FROM proposals
      JOIN products ON products.id = proposals.product_id
      JOIN shops ON shops.id = products.shop_id
      WHERE shops.domain = ? AND products.shopify_gid = ?
      ORDER BY proposals.created_at DESC, proposals.id DESC
      LIMIT 1
    `).get(shop, productGid) as Record<string, unknown> | undefined;
    if (!row) return null;
    const id = String(row.id);
    const fields = this.database.prepare('SELECT field FROM proposal_fields WHERE proposal_id = ? ORDER BY field')
      .all(id) as Array<{ field: string }>;
    return this.storedProposal(row, fields.map(value => value.field));
  }

  getProposal(proposalId: string): StoredProposal {
    const row = this.database.prepare(`
      SELECT proposals.*, products.shopify_gid,
        (SELECT sha256 FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_sha256,
        (SELECT bytes FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_bytes,
        (SELECT total FROM readiness_scores
          WHERE readiness_scores.evidence_run_id = proposals.verification_evidence_run_id) AS verified_score
      FROM proposals JOIN products ON products.id = proposals.product_id
      WHERE proposals.id = ?
    `).get(proposalId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Proposal does not exist.');
    const fields = this.database.prepare(`
      SELECT field FROM proposal_fields WHERE proposal_id = ? ORDER BY field
    `).all(proposalId) as Array<{ field: string }>;
    return this.storedProposal(row, fields.map(value => value.field));
  }

  listProposals(shop?: string): StoredProposal[] {
    const rows = this.database.prepare(`
      SELECT proposals.*, products.shopify_gid,
        (SELECT sha256 FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_sha256,
        (SELECT bytes FROM proposal_artifacts
          WHERE proposal_artifacts.proposal_id = proposals.id AND role = 'proposal') AS proposal_bytes,
        (SELECT total FROM readiness_scores
          WHERE readiness_scores.evidence_run_id = proposals.verification_evidence_run_id) AS verified_score
      FROM proposals JOIN products ON products.id = proposals.product_id
      JOIN shops ON shops.id = products.shop_id
      WHERE (? IS NULL OR shops.domain = ?)
      ORDER BY proposals.created_at DESC, proposals.id DESC
    `).all(shop ?? null, shop ?? null) as Array<Record<string, unknown>>;
    return rows.map(row => {
      const fields = this.database.prepare('SELECT field FROM proposal_fields WHERE proposal_id = ? ORDER BY field')
        .all(row.id as string) as Array<{ field: string }>;
      return this.storedProposal(row, fields.map(value => value.field));
    });
  }

  rejectProposal(proposalId: string, at: string): void {
    this.transitionProposal(proposalId, ['ready'], 'rejected', at, 'rejected', {});
  }

  markProposalStale(proposalId: string, at: string, changedFields: string[], updatedAtChanged = false): void {
    this.transitionProposal(proposalId, ['ready'], 'stale', at, 'stale_detected', { changedFields, updatedAtChanged });
  }

  approveProposal(proposalId: string, at: string): void {
    this.transitionProposal(proposalId, ['ready'], 'approved', at, 'approved', {});
    this.database.prepare('UPDATE proposals SET approved_at = ? WHERE id = ?').run(at, proposalId);
  }

  beginProposalWrite(proposalId: string, attemptId: string, at: string): void {
    this.transaction(() => {
      const changed = this.database.prepare(`UPDATE proposals SET status = 'applying' WHERE id = ? AND status = 'approved'`)
        .run(proposalId);
      if (Number(changed.changes) !== 1) throw new Error('Proposal is not approved for writing.');
      this.database.prepare(`INSERT INTO proposal_write_attempts (id, proposal_id, started_at) VALUES (?, ?, ?)`)
        .run(attemptId, proposalId, at);
      this.insertProposalEvent(proposalId, 'mutation_started', at, { attemptId });
    });
  }

  reconcileProposalWrite(
    proposalId: string,
    attemptId: string,
    outcome: 'candidate' | 'base' | 'ambiguous' | 'unreadable',
    at: string,
    errorCodes: string[],
  ): void {
    const status: ProposalStatus = outcome === 'candidate' ? 'applied' : outcome === 'base' ? 'not_applied' : 'ambiguous';
    this.transaction(() => {
      const attempt = this.database.prepare(`
        UPDATE proposal_write_attempts SET completed_at = ?, outcome = ?, error_codes_json = ?
        WHERE id = ? AND proposal_id = ?
      `).run(at, outcome, JSON.stringify(errorCodes), attemptId, proposalId);
      if (Number(attempt.changes) !== 1) throw new Error('Proposal write attempt cannot be reconciled.');
      const changed = this.database.prepare(`
        UPDATE proposals SET status = ?, verification_status = ?, completed_at = ?
        WHERE id = ? AND status IN ('applying', 'ambiguous')
      `).run(status, outcome === 'candidate' ? 'pending' : 'not_started', at, proposalId);
      if (Number(changed.changes) !== 1) throw new Error('Proposal write state cannot be reconciled.');
      this.insertProposalEvent(proposalId, 'mutation_reconciled', at, { outcome, errorCodes });
    });
  }

  proposalWriteAttempt(proposalId: string): { id: string; outcome: string | null } | null {
    const row = this.database.prepare(`
      SELECT id, outcome FROM proposal_write_attempts WHERE proposal_id = ?
    `).get(proposalId) as { id: string; outcome: string | null } | undefined;
    return row ?? null;
  }

  setProposalVerification(
    proposalId: string,
    status: ProposalVerificationStatus,
    evidenceRunId: string | null,
    at: string,
  ): void {
    this.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE proposals SET verification_status = ?, verification_evidence_run_id = ?, completed_at = ?
        WHERE id = ? AND status = 'applied'
      `).run(status, evidenceRunId, at, proposalId);
      if (Number(changed.changes) !== 1) throw new Error('Only an applied proposal can be verified.');
      this.insertProposalEvent(proposalId, 'verification_completed', at, { status, evidenceRunId });
    });
  }

  recoverInterruptedProposals(at: string): number {
    return this.transaction(() => {
      const approved = this.database.prepare(`
        SELECT id FROM proposals WHERE status = 'approved'
      `).all() as Array<{ id: string }>;
      for (const row of approved) {
        this.database.prepare(`UPDATE proposals SET status = 'ready', approved_at = NULL WHERE id = ?`).run(row.id);
        this.insertProposalEvent(row.id, 'approval_expired_after_restart', at, {});
      }
      const applying = this.database.prepare(`
        SELECT id FROM proposals WHERE status = 'applying'
      `).all() as Array<{ id: string }>;
      for (const row of applying) {
        this.database.prepare(`UPDATE proposals SET status = 'ambiguous', completed_at = ? WHERE id = ?`).run(at, row.id);
        this.insertProposalEvent(row.id, 'interrupted_write_requires_reconciliation', at, {});
      }
      return approved.length + applying.length;
    });
  }

  private readinessForRun(evidenceRunId: string): ReadinessScore | null {
    const row = this.database.prepare(`
      SELECT total, known_points, known_max FROM readiness_scores WHERE evidence_run_id = ?
    `).get(evidenceRunId) as { total: number | null; known_points: number; known_max: number } | undefined;
    if (!row) return null;
    const components = this.database.prepare(`
      SELECT component, weight, outcome, points, reason_codes_json, evidence_refs_json
      FROM readiness_components WHERE evidence_run_id = ? ORDER BY rowid
    `).all(evidenceRunId) as Array<{
      component: ReadinessScore['components'][number]['id'];
      weight: ReadinessScore['components'][number]['weight'];
      outcome: ReadinessScore['components'][number]['outcome'];
      points: number | null; reason_codes_json: string; evidence_refs_json: string;
    }>;
    return readinessScoreSchema.parse({
      schemaVersion: 1,
      total: row.total,
      knownPoints: row.known_points,
      knownMax: row.known_max,
      components: components.map(component => ({
        id: component.component,
        weight: component.weight,
        outcome: component.outcome,
        points: component.points,
        reasonCodes: JSON.parse(component.reason_codes_json) as unknown,
        evidenceRefs: JSON.parse(component.evidence_refs_json) as unknown,
      })),
      limitation: 'Diagnostic inventory-search readiness; not an SEO ranking claim.',
    });
  }

  private storedProposal(row: Record<string, unknown>, fields: string[]): StoredProposal {
    const current = readinessScoreSchema.parse(JSON.parse(String(row.current_readiness_json)));
    const predicted = readinessScoreSchema.parse(JSON.parse(String(row.predicted_readiness_json)));
    return {
      id: String(row.id),
      productGid: String(row.shopify_gid),
      kind: row.kind as ProposalKind,
      parentProposalId: row.parent_proposal_id === null ? null : String(row.parent_proposal_id),
      status: row.status as ProposalStatus,
      verificationStatus: row.verification_status as ProposalVerificationStatus,
      sourceEvidenceRunId: String(row.source_evidence_run_id),
      verificationEvidenceRunId: row.verification_evidence_run_id === null ? null : String(row.verification_evidence_run_id),
      currentScore: current.total,
      predictedScore: predicted.total,
      verifiedScore: row.verified_score === null || row.verified_score === undefined ? null : Number(row.verified_score),
      changedFields: fields,
      warningCodes: JSON.parse(String(row.warning_codes_json)) as string[],
      createdAt: String(row.created_at),
      approvedAt: row.approved_at === null ? null : String(row.approved_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      proposalArtifactSha256: String(row.proposal_sha256),
      proposalArtifactBytes: Number(row.proposal_bytes),
    };
  }

  private transitionProposal(
    proposalId: string,
    expected: ProposalStatus[],
    next: ProposalStatus,
    at: string,
    event: string,
    details: Record<string, unknown>,
  ): void {
    this.transaction(() => {
      const placeholders = expected.map(() => '?').join(', ');
      const changed = this.database.prepare(`UPDATE proposals SET status = ?, completed_at = ? WHERE id = ? AND status IN (${placeholders})`)
        .run(next, ['ready', 'approved', 'applying'].includes(next) ? null : at, proposalId, ...expected);
      if (Number(changed.changes) !== 1) throw new Error('Proposal is not in a valid state for this action.');
      this.insertProposalEvent(proposalId, event, at, details);
    });
  }

  private insertProposalArtifacts(proposalId: string, artifacts: ProposalArtifactIndex[]): void {
    const statement = this.database.prepare(`
      INSERT INTO proposal_artifacts (proposal_id, role, relative_path, media_type, sha256, bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const artifact of artifacts) statement.run(
      proposalId, artifact.role, artifact.relativePath, artifact.mediaType, artifact.sha256, artifact.bytes,
    );
  }

  private insertProposalEvent(proposalId: string, event: string, at: string, details: Record<string, unknown>): void {
    this.database.prepare(`
      INSERT INTO proposal_events (id, proposal_id, event_type, details_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), proposalId, event, JSON.stringify(details), at);
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

  private validateTimestamp(value: string, label: string): void {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      throw new Error(`${label} must be a canonical UTC timestamp.`);
    }
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
