import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanEvidenceBundle } from '../dist/packages/agent/src/combined-scan.js';
import { formatEvidenceBundle } from '../dist/apps/cli/src/bundle-output.js';

const productId = 'gid://shopify/Product/700';
const shop = 'example.myshopify.com';

function adminReport(onlineStoreUrl = 'https://store.example/en-ca/products/synthetic-item') {
  return {
    schemaVersion: 1, mode: 'admin_only', source: 'shopify_admin_graphql', productId,
    observationWindow: { startedAt: '2026-10-15T11:59:58.000Z', completedAt: '2026-10-15T11:59:59.000Z' },
    apiVersion: { requested: '2026-10', response: '2026-10' }, pageCount: 1, complete: true,
    limitations: ['Synthetic Admin context.'],
    product: {
      id: productId, status: 'ACTIVE', onlineStoreUrl, updatedAt: '2026-10-15T11:00:00.000Z',
      variants: [{
        id: 'gid://shopify/ProductVariant/701', legacyResourceId: '701',
        selectedOptions: [{ name: 'Size', value: 'One' }], inventoryPolicy: 'DENY',
        inventoryQuantity: 1, sellableOnlineQuantity: 1, updatedAt: '2026-10-15T10:00:00.000Z',
        inventoryItem: { id: 'gid://shopify/InventoryItem/701', tracked: true, updatedAt: '2026-10-15T09:00:00.000Z' },
      }],
    },
  };
}

function fetched(text, contentType) {
  const body = new TextEncoder().encode(text);
  return {
    reasonCode: null, status: 200, contentType, redirectObserved: false,
    sha256: 'a'.repeat(64), byteCount: body.length, body,
  };
}

const ajaxText = JSON.stringify({
  id: 700, handle: 'synthetic-item', available: true,
  variants: [{ id: 701, available: true }],
});
const htmlText = `<!doctype html><html><head>
  <link rel="canonical" href="https://store.example/products/synthetic-item">
  <script type="Application/LD+JSON; charset=utf-8">{
    "@context":"https://schema.org","@type":"Product","@id":"#product",
    "offers":{"@type":"Offer","url":"/products/synthetic-item?variant=701","price":"10.00","priceCurrency":"CAD","availability":"https://schema.org/InStock"}
  }</script></head><body></body></html>`;

function dependencies({ admin = adminReport(), ajax = fetched(ajaxText, 'application/json'), html = fetched(htmlText, 'text/html') } = {}) {
  const calls = [];
  const saved = [];
  const times = [new Date('2026-10-15T12:00:00.000Z'), new Date('2026-10-15T12:00:02.000Z')];
  return {
    calls, saved,
    value: {
      async readConfig() { calls.push('config'); return { version: 1, shop }; },
      async validateTarget() { calls.push('validate'); },
      async readToken() { calls.push('token'); return 'synthetic-secret'; },
      async readAdmin() { calls.push('admin'); return admin; },
      async fetchAjax() { calls.push('ajax'); return ajax; },
      async fetchHtml() { calls.push('html'); return html; },
      async saveBundle(_directory, _shop, _productId, _runId, inputs, bundle) {
        calls.push('save'); saved.push({ inputs, bundle }); return bundle;
      },
      now() { return times.shift() ?? new Date('2026-10-15T12:00:02.000Z'); },
      uuid() { return '123e4567-e89b-42d3-a456-426614174000'; },
    },
  };
}

test('collects one observed four-source bundle with safe aggregate output', async () => {
  const fixture = dependencies();
  const result = await scanEvidenceBundle('unused', productId, fixture.value);
  assert.deepEqual(fixture.calls, ['config', 'validate', 'token', 'admin', 'ajax', 'html', 'save']);
  assert.equal(result.bundle.collectionStatus, 'complete');
  assert.deepEqual(Object.values(result.bundle.sources).map(source => source.outcome),
    ['observed', 'observed', 'observed', 'observed']);
  assert.deepEqual(result.bundle.artifacts.map(artifact => artifact.relativePath),
    ['admin.json', 'ajax.json', 'html.html', 'jsonld.json']);
  assert.equal(result.bundle.sources.jsonld.claims.length, 2);
  assert.equal(result.bundle.sources.jsonld.claims.find(claim => claim.kind === 'Offer').matchedLegacyVariantId, '701');
  const output = formatEvidenceBundle(result).join('\n');
  assert.match(output, /EVIDENCE BUNDLE/);
  assert.match(output, /Sources observed: 4; inconclusive: 0/);
  assert.doesNotMatch(output, /gid:\/\/|synthetic-item|store\.example|701|10\.00|2026-|123e|unused|secret/i);
});

test('unpublished Admin evidence makes every public source inconclusive without public requests', async () => {
  const fixture = dependencies({ admin: adminReport(null) });
  const result = await scanEvidenceBundle('unused', productId, fixture.value);
  assert.deepEqual(fixture.calls, ['config', 'validate', 'token', 'admin', 'save']);
  assert.equal(result.bundle.collectionStatus, 'partial');
  for (const source of ['ajax', 'html', 'jsonld']) {
    assert.equal(result.bundle.sources[source].reasonCode, 'not_published_to_online_store');
  }
});

test('keeps HTML evidence when Ajax fails and distinguishes absent from malformed JSON-LD', async () => {
  const ajaxFailure = {
    reasonCode: 'timeout', status: null, contentType: null, redirectObserved: false,
    sha256: null, byteCount: null, body: null,
  };
  let fixture = dependencies({ ajax: ajaxFailure, html: fetched('<html><head></head></html>', 'text/html') });
  let result = await scanEvidenceBundle('unused', productId, fixture.value);
  assert.equal(result.bundle.sources.ajax.reasonCode, 'timeout');
  assert.equal(result.bundle.sources.html.outcome, 'observed');
  assert.equal(result.bundle.sources.jsonld.outcome, 'observed');
  assert.equal(result.bundle.sources.jsonld.presence, 'absent');

  fixture = dependencies({ html: fetched('<html><head><script type="application/ld+json">{</script></head></html>', 'text/html') });
  result = await scanEvidenceBundle('unused', productId, fixture.value);
  assert.equal(result.bundle.sources.html.outcome, 'observed');
  assert.equal(result.bundle.sources.jsonld.reasonCode, 'malformed_jsonld');
  assert.equal(result.bundle.sources.jsonld.validBlockCount, 0);
});

test('validates eligibility before credentials and collection', async () => {
  const fixture = dependencies();
  fixture.value.validateTarget = async () => { fixture.calls.push('validate'); throw new Error('Synthetic rejection'); };
  await assert.rejects(() => scanEvidenceBundle('unused', productId, fixture.value), /Synthetic rejection/);
  assert.deepEqual(fixture.calls, ['config', 'validate']);
});
