import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewCatalogImport } from '../dist/packages/agent/src/import.js';
import { formatImportPreview } from '../dist/apps/cli/src/import-output.js';

test('preview uses injected boundaries, returns safe aggregates, and writes no files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-preview-'));
  const privateTitle = 'Private synthetic catalog title';
  const calls = [];
  const dependencies = {
    async readConfig(value) {
      calls.push(['config', value]);
      return { version: 1, shop: 'example.myshopify.com' };
    },
    async readToken(value) {
      calls.push(['token', value]);
      return 'synthetic-credential';
    },
    async readCatalog(shop, token, limit) {
      calls.push(['catalog', shop, token, limit]);
      return {
        complete: true,
        provenance: {
          observedAt: '2026-10-15T12:00:00.000Z',
          evidenceSource: 'shopify_admin_graphql',
          apiVersion: '2026-10',
        },
        products: [
          { title: privateTitle, publishedToOnlineStore: true, variants: [{}, {}] },
          { title: 'Another synthetic title', publishedToOnlineStore: false, variants: [{}] },
        ],
        requestMetadata: [{ requestId: 'private-request-id' }],
      };
    },
  };
  try {
    const summary = await previewCatalogImport(directory, 5, dependencies);
    assert.deepEqual(summary, {
      status: 'preview-complete',
      productCount: 2,
      variantCount: 3,
      publishedProductCount: 1,
    });
    assert.deepEqual(calls.map(call => call[0]), ['config', 'token', 'catalog']);
    const output = formatImportPreview(summary).join('\n');
    assert.match(output, /PREVIEW COMPLETE/);
    assert.match(output, /Products: 2/);
    assert.doesNotMatch(output, /Private synthetic|request-id|credential|myshopify/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview validates the limit before reading config or credentials', async () => {
  let touchedBoundary = false;
  const dependencies = {
    async readConfig() { touchedBoundary = true; throw new Error('not expected'); },
    async readToken() { touchedBoundary = true; throw new Error('not expected'); },
    async readCatalog() { touchedBoundary = true; throw new Error('not expected'); },
  };
  for (const limit of [0, 251, 1.5, Number.NaN]) {
    await assert.rejects(() => previewCatalogImport('unused', limit, dependencies), /whole number/);
  }
  assert.equal(touchedBoundary, false);
});
