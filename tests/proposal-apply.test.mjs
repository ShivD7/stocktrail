import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize } from '../dist/packages/agent/src/config.js';
import { improveProduct, applyProposal } from '../dist/packages/agent/src/proposals.js';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';
import { scoreInventorySearchReadiness } from '../dist/packages/scorer/src/readiness.js';
import { ShopifyMutationOutcomeUnknownError } from '../dist/packages/shopify/src/product-update.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/9200';
const variantId = 'gid://shopify/ProductVariant/9201';
const sourceRun = '11111111-1111-4111-8111-111111111111';
const verifyRun = '44444444-4444-4444-8444-444444444444';
const proposalId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';

function admin(content, updatedAt = '2026-10-17T10:00:00.000Z') {
  return {
    schemaVersion: 1, mode: 'admin_only', source: 'shopify_admin_graphql', productId,
    observationWindow: { startedAt: '2026-10-17T12:00:00.000Z', completedAt: '2026-10-17T12:00:01.000Z' },
    apiVersion: { requested: '2026-10', response: '2026-10' }, pageCount: 1, complete: true,
    limitations: ['Synthetic fixture.'],
    product: {
      id: productId, ...content, handle: 'synthetic', status: 'ACTIVE',
      onlineStoreUrl: 'https://synthetic.invalid/products/item', updatedAt,
      variants: [{
        id: variantId, legacyResourceId: '9201', sku: 'SYNTH', selectedOptions: [], inventoryPolicy: 'DENY',
        inventoryQuantity: 1, sellableOnlineQuantity: 1, updatedAt: '2026-10-17T11:00:00.000Z',
        inventoryItem: { id: 'gid://shopify/InventoryItem/9202', tracked: true, updatedAt: '2026-10-17T11:00:00.000Z' },
      }],
    },
  };
}

const baseContent = {
  title: 'Trail Shoe | Only 3 left',
  descriptionHtml: '<p>Durable.</p><p>Ships tomorrow.</p>',
  seo: { title: null, description: null },
};
const candidateContent = {
  title: 'Trail Shoe', descriptionHtml: '<p>Durable.</p>',
  seo: { title: 'Trail Shoe', description: 'Durable.' },
};

function score(content) {
  return scoreInventorySearchReadiness({
    evaluations: [{
      schemaVersion: 1, ruleVersion: 1, ruleId: 'ST-001', productId, variantId,
      result: 'pass', severity: 'medium', reasonCode: 'synthetic_pass', match: null,
      requiredSources: ['admin', 'jsonld'], evidenceRunId: sourceRun,
      evaluatedAt: '2026-10-17T12:00:02.000Z',
    }],
    matches: [{ outcome: 'matched', variantId, legacyVariantId: '9201', method: 'variant_id', confidence: 'authoritative', corroboratingMethods: ['variant_id'] }],
    structuredData: { sourceOutcome: 'observed', presence: 'present', malformedBlockCount: 0, variantOfferCount: 1, supportedAvailabilityCount: 1 },
    adminContent: {
      title: content.title, descriptionHtml: content.descriptionHtml, seoTitle: content.seo.title, seoDescription: content.seo.description,
      productUpdatedAt: '2026-10-17T10:00:00.000Z', latestInventoryUpdatedAt: '2026-10-17T11:00:00.000Z',
    },
  });
}

async function recordRun(directory, runId, report, readiness) {
  const scanDirectory = join(directory, 'artifacts', 'scans', runId);
  await mkdir(scanDirectory, { recursive: true });
  const text = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(scanDirectory, 'admin.json'), text);
  const repository = await openCatalogRepository(directory);
  try {
    repository.recordEvidenceRun(shop, productId, {
      runId, status: 'complete', startedAt: report.observationWindow.startedAt, completedAt: report.observationWindow.completedAt,
      sources: [
        { source: 'admin', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 },
        { source: 'browser', outcome: 'observed', reasonCode: null, status: null, contentType: null, itemCount: 1 },
      ],
      artifacts: [{ source: 'admin', relativePath: 'admin.json', mediaType: 'application/json', sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }],
    });
    repository.recordDiagnosticResults(shop, productId, { evidenceRunId: runId, evaluatedAt: report.observationWindow.completedAt, evaluations: [], readiness });
  } finally { repository.close(); }
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-proposal-apply-'));
  await initialize(directory, shop);
  const repository = await openCatalogRepository(directory);
  repository.importCatalog(shop, [{
    id: productId, ...baseContent, handle: 'synthetic', status: 'ACTIVE', updatedAt: '2026-10-17T10:00:00.000Z',
    onlineStoreUrl: 'https://synthetic.invalid/products/item', publishedToOnlineStore: true,
    variants: [{ id: variantId, legacyResourceId: '9201', sku: 'SYNTH', selectedOptions: [], inventoryPolicy: 'DENY', inventoryQuantity: 1, sellableOnlineQuantity: 1, updatedAt: '2026-10-17T11:00:00.000Z', inventoryItem: { tracked: true } }],
  }], true, { observedAt: '2026-10-17T12:00:00.000Z', evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10' });
  repository.close();
  await recordRun(directory, sourceRun, admin(baseContent), score(baseContent));
  const proposal = await improveProduct(directory, productId, {
    openRepository: openCatalogRepository,
    readToken: async () => { throw new Error('unused'); },
    readAdmin: async () => { throw new Error('unused'); },
    verifyWriteScope: async () => { throw new Error('unused'); },
    mutate: async () => { throw new Error('unused'); },
    verify: async () => { throw new Error('unused'); },
    now: () => new Date('2026-10-17T12:01:00.000Z'), uuid: () => proposalId,
  });
  assert.ok(proposal.proposal);
  return directory;
}

test('stale preflight blocks approval and performs no mutation', async () => {
  const directory = await setup();
  let mutations = 0;
  try {
    const result = await applyProposal(directory, proposalId, `APPLY ${proposalId}`, false, {
      openRepository: openCatalogRepository,
      readToken: async () => 'synthetic-secret-never-logged',
      verifyWriteScope: async () => undefined,
      readAdmin: async () => admin({ ...baseContent, title: 'Concurrent title' }, '2026-10-17T12:02:00.000Z'),
      mutate: async () => { mutations += 1; throw new Error('must not run'); },
      verify: async () => { throw new Error('must not run'); },
      now: () => new Date('2026-10-17T12:03:00.000Z'), uuid: () => attemptId,
    });
    assert.equal(result.status, 'stale');
    assert.equal(mutations, 0);
    assert.deepEqual(result.changedFields, ['title']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('timeout is reconciled as applied without retry and verified through a fresh Phase 3 result', async () => {
  const directory = await setup();
  let reads = 0;
  let mutations = 0;
  try {
    const result = await applyProposal(directory, proposalId, `APPLY ${proposalId}`, false, {
      openRepository: openCatalogRepository,
      readToken: async () => 'synthetic-secret-never-logged',
      verifyWriteScope: async () => undefined,
      readAdmin: async () => {
        reads += 1;
        return reads === 1 ? admin(baseContent) : admin(candidateContent, '2026-10-17T12:03:00.000Z');
      },
      mutate: async () => { mutations += 1; throw new ShopifyMutationOutcomeUnknownError(['transport_failure']); },
      verify: async () => {
        const report = admin(candidateContent, '2026-10-17T12:03:00.000Z');
        report.observationWindow = { startedAt: '2026-10-17T12:04:00.000Z', completedAt: '2026-10-17T12:04:01.000Z' };
        await recordRun(directory, verifyRun, report, score(candidateContent));
        return { bundle: { runId: verifyRun }, evaluations: [{ result: 'pass' }] };
      },
      now: () => new Date('2026-10-17T12:05:00.000Z'),
      uuid: (() => { const values = [attemptId, '55555555-5555-4555-8555-555555555555']; return () => values.shift() ?? '66666666-6666-4666-8666-666666666666'; })(),
    });
    assert.equal(mutations, 1);
    assert.equal(result.status, 'applied');
    assert.equal(result.verification, 'verified');
    assert.equal(result.diagnosticOutcome, 'pass');
    const repository = await openCatalogRepository(directory);
    try {
      const stored = repository.getProposal(proposalId);
      assert.equal(stored.verificationEvidenceRunId, verifyRun);
      assert.equal(stored.verifiedScore, 100);
    } finally { repository.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
