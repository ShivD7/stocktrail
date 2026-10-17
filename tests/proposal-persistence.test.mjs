import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';
import { createImprovementProposal, contentFingerprint } from '../dist/packages/proposals/src/index.js';
import { writeProposalArtifacts, readProposalArtifact } from '../dist/packages/agent/src/proposal-storage.js';
import { scoreInventorySearchReadiness } from '../dist/packages/scorer/src/readiness.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/9100';
const variantId = 'gid://shopify/ProductVariant/9101';
const runId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-10-17T12:00:00.000Z';

function product() {
  return {
    id: productId, title: 'Trail Shoe | Only 3 left',
    descriptionHtml: '<p>Durable.</p><p>Ships tomorrow.</p>',
    seo: { title: null, description: null }, handle: 'synthetic', status: 'ACTIVE',
    updatedAt: '2026-10-17T10:00:00.000Z', onlineStoreUrl: 'https://synthetic.invalid/products/item',
    publishedToOnlineStore: true, variants: [{
      id: variantId, legacyResourceId: '9101', sku: 'SYNTH', selectedOptions: [],
      inventoryPolicy: 'DENY', inventoryQuantity: 1, sellableOnlineQuantity: 1,
      updatedAt: '2026-10-17T11:00:00.000Z', inventoryItem: { tracked: true },
    }],
  };
}

function score() {
  return scoreInventorySearchReadiness({
    evaluations: [{
      schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId, variantId,
      result: 'pass', severity: 'medium', reasonCode: 'synthetic_pass', match: null,
      requiredSources: ['admin', 'jsonld'], evidenceRunId: runId, evaluatedAt: observedAt,
    }],
    matches: [{ outcome: 'matched', variantId, legacyVariantId: '9101', method: 'variant_id', confidence: 'authoritative', corroboratingMethods: ['variant_id'] }],
    structuredData: { sourceOutcome: 'observed', presence: 'present', malformedBlockCount: 0, variantOfferCount: 1, supportedAvailabilityCount: 1 },
    adminContent: {
      title: product().title, descriptionHtml: product().descriptionHtml,
      seoTitle: null, seoDescription: null,
      productUpdatedAt: '2026-10-17T10:00:00.000Z', latestInventoryUpdatedAt: '2026-10-17T11:00:00.000Z',
    },
  });
}

function proposal() {
  const content = { title: product().title, descriptionHtml: product().descriptionHtml, seo: { title: null, description: null } };
  return createImprovementProposal({
    id: proposalId, createdAt: observedAt,
    snapshot: {
      productId, productUpdatedAt: '2026-10-17T10:00:00.000Z', latestInventoryUpdatedAt: '2026-10-17T11:00:00.000Z',
      observedAt, evidenceRunId: runId, content,
      fingerprint: contentFingerprint(productId, '2026-10-17T10:00:00.000Z', content),
    },
    currentReadiness: score(),
  }).proposal;
}

async function seeded(directory) {
  const repository = await openCatalogRepository(directory);
  repository.importCatalog(shop, [product()], true, { observedAt, evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10' });
  repository.recordEvidenceRun(shop, productId, {
    runId, status: 'complete', startedAt: observedAt, completedAt: '2026-10-17T12:00:01.000Z',
    sources: [
      { source: 'admin', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 },
      { source: 'browser', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 },
    ],
    artifacts: [{ source: 'admin', relativePath: 'admin.json', mediaType: 'application/json', sha256: 'a'.repeat(64), bytes: 10 }],
  });
  repository.recordDiagnosticResults(shop, productId, { evidenceRunId: runId, evaluatedAt: observedAt, evaluations: [], readiness: score() });
  return repository;
}

test('persists only proposal metadata in SQLite and integrity-indexed content in private artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-proposal-db-'));
  let repository;
  try {
    repository = await seeded(directory);
    const value = proposal();
    assert.ok(value);
    const artifacts = await writeProposalArtifacts(directory, value);
    repository.recordProposal(shop, value, artifacts);
    const stored = repository.getProposal(proposalId);
    assert.equal(stored.status, 'ready');
    assert.equal(stored.currentScore, 75);
    assert.equal(stored.predictedScore, 100);
    assert.deepEqual(repository.latestProposalEvidence(shop, productId)?.readiness, score());
    assert.deepEqual((await readProposalArtifact(directory, proposalId, stored.proposalArtifactSha256)).candidate, value.candidate);

    const database = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 7);
      const sql = database.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'proposal%'").all().map(row => row.sql).join('\n');
      assert.doesNotMatch(sql, /description_html|seo_description|access.?token|request.?id|header|raw.?response/i);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM proposal_events').get().count, 2);
    } finally { database.close(); }
    const raw = await readFile(join(directory, 'artifacts', 'proposals', proposalId, 'proposal.json'), 'utf8');
    assert.match(raw, /Durable/);
  } finally {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('expires unconsumed approval and marks interrupted mutation attempts ambiguous', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-proposal-recovery-'));
  let repository;
  try {
    repository = await seeded(directory);
    const value = proposal();
    const artifacts = await writeProposalArtifacts(directory, value);
    repository.recordProposal(shop, value, artifacts);
    repository.approveProposal(proposalId, '2026-10-17T12:01:00.000Z');
    assert.equal(repository.recoverInterruptedProposals('2026-10-17T12:02:00.000Z'), 1);
    assert.equal(repository.getProposal(proposalId).status, 'ready');
    repository.approveProposal(proposalId, '2026-10-17T12:03:00.000Z');
    repository.beginProposalWrite(proposalId, '33333333-3333-4333-8333-333333333333', '2026-10-17T12:03:01.000Z');
    assert.equal(repository.recoverInterruptedProposals('2026-10-17T12:04:00.000Z'), 1);
    assert.equal(repository.getProposal(proposalId).status, 'ambiguous');
  } finally {
    repository?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
