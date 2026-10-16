import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';
import { describeBundleArtifact, writeBundleRun } from '../dist/packages/agent/src/bundle-storage.js';
import { saveEvidenceBundle } from '../dist/packages/agent/src/combined-scan.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/801';
const provenance = { observedAt: '2026-10-15T12:00:00.000Z', evidenceSource: 'shopify_admin_graphql', apiVersion: '2026-10' };
const inputs = [{ source: 'admin', relativePath: 'admin.json', mediaType: 'application/json', contents: '{"safe":true}\n' }];

function product() {
  return {
    id: productId, title: 'Synthetic', descriptionHtml: '', seo: { title: null, description: null },
    handle: 'synthetic', status: 'ACTIVE', updatedAt: '2026-10-01T00:00:00Z',
    onlineStoreUrl: null, publishedToOnlineStore: false, variants: [],
  };
}

function bundle(runId) {
  const artifact = describeBundleArtifact(inputs[0]);
  const window = { startedAt: '2026-10-15T12:00:00.000Z', completedAt: '2026-10-15T12:00:01.000Z' };
  const envelope = (reasonCode, source) => ({
    outcome: reasonCode === null ? 'observed' : 'inconclusive', reasonCode,
    observationWindow: window, artifactRefs: source === 'admin' ? [artifact] : [],
    itemCount: 0, status: null, contentType: null,
  });
  return {
    schemaVersion: 1, runId, productId, collectionStatus: 'partial', observationWindow: window,
    sources: {
      admin: envelope(null, 'admin'),
      ajax: envelope('not_published_to_online_store', 'ajax'),
      html: envelope('not_published_to_online_store', 'html'),
      jsonld: {
        ...envelope('not_published_to_online_store', 'jsonld'),
        presence: 'unknown', blockCount: 0, validBlockCount: 0, claims: [],
      },
    },
    artifacts: [artifact], limitations: ['Collection only.'],
  };
}

test('atomically persists a private bundle and indexes only integrity metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-bundle-'));
  const runId = '123e4567-e89b-42d3-a456-426614174001';
  try {
    const repository = await openCatalogRepository(directory);
    repository.importCatalog(shop, [product()], true, provenance);
    repository.addMonitoredProduct(shop, productId);
    repository.close();

    await saveEvidenceBundle(directory, shop, productId, runId, inputs, bundle(runId));
    const finalDirectory = join(directory, 'artifacts', 'scans', runId);
    assert.deepEqual((await readdir(finalDirectory)).sort(), ['admin.json', 'bundle.json']);
    const saved = JSON.parse(await readFile(join(finalDirectory, 'bundle.json'), 'utf8'));
    assert.equal(saved.runId, runId);

    const database = new DatabaseSync(join(directory, 'stocktrail.sqlite'), { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM evidence_runs').get().count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM evidence_sources').get().count, 4);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM evidence_artifacts').get().count, 2);
      const schema = database.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE 'evidence_%'`).all().map(row => row.sql).join('\n');
      assert.doesNotMatch(schema, /token|credential|request.?id|header|raw.?response|query.?cost/i);
    } finally { database.close(); }

    await assert.rejects(() => writeBundleRun(directory, runId, inputs, bundle(runId)), /securely/);
    assert.deepEqual((await readdir(finalDirectory)).sort(), ['admin.json', 'bundle.json']);
    assert.deepEqual(await readdir(join(directory, 'artifacts', '.staging')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('removes only the current final directory when metadata insertion fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-bundle-failure-'));
  const runId = '123e4567-e89b-42d3-a456-426614174002';
  try {
    await assert.rejects(
      () => saveEvidenceBundle(directory, shop, productId, runId, inputs, bundle(runId)),
      /No evidence bundle was saved/,
    );
    assert.deepEqual(await readdir(join(directory, 'artifacts', 'scans')), []);
    assert.deepEqual(await readdir(join(directory, 'artifacts', '.staging')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
