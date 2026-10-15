import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistCatalogImport } from '../dist/packages/agent/src/import.js';
import { formatPersistentImport } from '../dist/apps/cli/src/import-output.js';

test('persistent import collects before opening the database and emits safe aggregates', async () => {
  const calls = [];
  let closed = false;
  const privateTitle = 'Synthetic private title';
  const dependencies = {
    async readConfig() {
      calls.push('config');
      return { version: 1, shop: 'example.myshopify.com' };
    },
    async readToken() {
      calls.push('token');
      return 'synthetic-credential';
    },
    async readCatalog() {
      calls.push('catalog');
      return {
        complete: true,
        provenance: {
          observedAt: '2026-10-15T12:00:00.000Z',
          evidenceSource: 'shopify_admin_graphql',
          apiVersion: '2026-10',
        },
        requestMetadata: [{ requestId: 'synthetic-private-request' }],
        products: [{
          title: privateTitle,
          publishedToOnlineStore: true,
          variants: [{}, {}],
        }],
      };
    },
    async openRepository() {
      calls.push('database');
      return {
        importCatalog(_shop, products, fullSnapshot, provenance) {
          calls.push('write');
          assert.equal(products[0].title, privateTitle);
          assert.equal(fullSnapshot, true);
          assert.deepEqual(provenance, {
            observedAt: '2026-10-15T12:00:00.000Z',
            evidenceSource: 'shopify_admin_graphql',
            apiVersion: '2026-10',
          });
          assert.doesNotMatch(JSON.stringify(provenance), /request|credential/);
          return { productCount: 1, variantCount: 2, deactivatedProductCount: 0 };
        },
        close() { closed = true; },
      };
    },
  };

  const summary = await persistCatalogImport('unused', 250, dependencies);
  assert.deepEqual(calls, ['config', 'token', 'catalog', 'database', 'write']);
  assert.equal(closed, true);
  const output = formatPersistentImport(summary).join('\n');
  assert.match(output, /IMPORT COMPLETE/);
  assert.match(output, /Products imported: 1/);
  assert.doesNotMatch(output, /Synthetic private|credential|request|myshopify/);
});

test('persistent import validates before touching configuration or credentials', async () => {
  let touchedBoundary = false;
  const dependencies = {
    async readConfig() { touchedBoundary = true; throw new Error('not expected'); },
    async readToken() { touchedBoundary = true; throw new Error('not expected'); },
    async readCatalog() { touchedBoundary = true; throw new Error('not expected'); },
    async openRepository() { touchedBoundary = true; throw new Error('not expected'); },
  };
  for (const limit of [0, 251, 1.5, Number.NaN]) {
    await assert.rejects(() => persistCatalogImport('unused', limit, dependencies), /whole number/);
  }
  assert.equal(touchedBoundary, false);
});
