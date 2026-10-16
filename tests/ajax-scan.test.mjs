import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanAjaxEvidence,
  writeAjaxEvidence,
} from '../dist/packages/agent/src/ajax-scan.js';
import { formatAjaxScan } from '../dist/apps/cli/src/ajax-output.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/700';

function adminVariant(number, legacyResourceId = String(number)) {
  return {
    id: `gid://shopify/ProductVariant/${number}`,
    legacyResourceId,
    selectedOptions: [{ name: 'Size', value: 'Synthetic' }],
    inventoryPolicy: 'DENY',
    inventoryQuantity: 3,
    sellableOnlineQuantity: 2,
    updatedAt: '2026-10-15T10:00:00.000Z',
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${number}`,
      tracked: true,
      updatedAt: '2026-10-15T09:00:00.000Z',
    },
  };
}

function adminReport(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'admin_only',
    source: 'shopify_admin_graphql',
    productId,
    observationWindow: {
      startedAt: '2026-10-15T11:59:58.000Z',
      completedAt: '2026-10-15T11:59:59.000Z',
    },
    apiVersion: { requested: '2026-10', response: '2026-10' },
    pageCount: 1,
    complete: true,
    limitations: ['Synthetic Admin context.'],
    product: {
      id: productId,
      status: 'ACTIVE',
      onlineStoreUrl: 'https://store.example/en-ca/products/synthetic-item',
      updatedAt: '2026-10-15T11:00:00.000Z',
      variants: [adminVariant(701), adminVariant(702)],
      ...overrides,
    },
  };
}

function body(product = {}) {
  return new TextEncoder().encode(JSON.stringify({
    id: 700,
    handle: 'synthetic-item',
    available: true,
    requires_selling_plan: false,
    variants: [
      { id: 701, available: true, inventory_management: 'shopify', requires_selling_plan: false },
      { id: 702, available: false, inventory_management: null, requires_selling_plan: false },
    ],
    ...product,
  }));
}

function fetchResult(responseBody = body()) {
  return {
    reasonCode: null,
    status: 200,
    contentType: 'application/json',
    redirectObserved: false,
    sha256: 'a'.repeat(64),
    byteCount: responseBody.length,
    body: responseBody,
  };
}

function dependencies({ admin = adminReport(), fetched = fetchResult(), validateError = null } = {}) {
  const calls = [];
  const written = [];
  const times = [new Date('2026-10-15T12:00:00.000Z'), new Date('2026-10-15T12:00:02.000Z')];
  return {
    calls,
    written,
    value: {
      async readConfig() { calls.push('config'); return { version: 1, shop }; },
      async validateTarget() {
        calls.push('validate');
        if (validateError) throw new Error(validateError);
      },
      async readToken() { calls.push('token'); return 'synthetic-credential'; },
      async readAdmin() { calls.push('admin'); return admin; },
      async fetchAjax(target) { calls.push('ajax'); assert.equal(target.handle, 'synthetic-item'); return fetched; },
      async writeEvidence(_directory, report) { calls.push('write'); written.push(report); return 'C:\\Private\\ajax.json'; },
      now() { return times.shift() ?? new Date('2026-10-15T12:00:02.000Z'); },
    },
  };
}

test('records an observed exact match and emits aggregate path-free output', async () => {
  const fixture = dependencies();
  const result = await scanAjaxEvidence('unused', productId, fixture.value);
  assert.deepEqual(fixture.calls, ['config', 'validate', 'token', 'admin', 'ajax', 'write']);
  assert.equal(result.report.outcome, 'observed');
  assert.equal(result.report.reasonCode, null);
  assert.deepEqual(result.report.matchCounts, { adminVariants: 2, ajaxVariants: 2, matched: 2 });
  assert.deepEqual(result.report.availabilityCounts, { available: 1, unavailable: 1 });
  assert.equal(result.report.requestContext.cookiesSent, false);
  assert.equal(result.report.requestContext.localePath, '/en-ca');
  assert.equal(result.report.body.sha256, 'a'.repeat(64));
  const serialized = JSON.stringify(result.report);
  assert.doesNotMatch(serialized, /synthetic-credential|store\.example|Private|"title"|"sku"|raw/i);

  const output = formatAjaxScan(result).join('\n');
  assert.match(output, /AJAX ONLY/);
  assert.match(output, /Outcome: OBSERVED/);
  assert.match(output, /Matched variants: 2/);
  assert.match(output, /Available variants: 1/);
  assert.doesNotMatch(output, /gid:\/\/|synthetic-item|store\.example|2026-|Private|ajax\.json/i);
});

test('saves not-published evidence without any public request', async () => {
  const fixture = dependencies({ admin: adminReport({ onlineStoreUrl: null }) });
  const result = await scanAjaxEvidence('unused', productId, fixture.value);
  assert.deepEqual(fixture.calls, ['config', 'validate', 'token', 'admin', 'write']);
  assert.equal(result.report.outcome, 'inconclusive');
  assert.equal(result.report.reasonCode, 'not_published_to_online_store');
  assert.equal(result.report.http.status, null);
  assert.equal(result.report.body.sha256, null);
});

test('eligibility failure stops token, Admin, DNS, and storefront work', async () => {
  const fixture = dependencies({ validateError: 'Synthetic target rejection' });
  await assert.rejects(() => scanAjaxEvidence('unused', productId, fixture.value), /target rejection/);
  assert.deepEqual(fixture.calls, ['config', 'validate']);
});

test('reports exact identity mismatch reasons without claiming observation', async () => {
  const cases = [
    [adminReport(), fetchResult(body({ id: 999 })), 'product_id_mismatch'],
    [adminReport(), fetchResult(body({ handle: 'different-item' })), 'handle_mismatch'],
    [adminReport(), fetchResult(body({ variants: [{ id: 701 }] })), 'missing_ajax_variant'],
    [adminReport(), fetchResult(body({ variants: [{ id: 701 }, { id: 702 }, { id: 703 }] })), 'unexpected_ajax_variant'],
    [adminReport({ variants: [adminVariant(701, '701'), adminVariant(702, '701')] }), fetchResult(), 'duplicate_admin_legacy_id'],
    [adminReport({ variants: Array.from({ length: 251 }, (_, index) => adminVariant(index + 1)) }), fetchResult(), 'variant_limit_exceeded'],
  ];
  for (const [admin, fetched, reason] of cases) {
    const fixture = dependencies({ admin, fetched });
    const result = await scanAjaxEvidence('unused', productId, fixture.value);
    assert.equal(result.report.outcome, 'inconclusive');
    assert.equal(result.report.reasonCode, reason);
    assert.equal(result.report.complete, false);
  }
});

test('persists parser and transport reason codes without raw bodies', async () => {
  const transport = dependencies({
    fetched: {
      reasonCode: 'redirect_observed', status: 302, contentType: 'text/html',
      redirectObserved: true, sha256: null, byteCount: null, body: null,
    },
  });
  let result = await scanAjaxEvidence('unused', productId, transport.value);
  assert.equal(result.report.reasonCode, 'redirect_observed');
  assert.equal(result.report.http.redirectObserved, true);

  const timeout = dependencies({
    fetched: {
      reasonCode: 'timeout', status: null, contentType: null,
      redirectObserved: false, sha256: null, byteCount: null, body: null,
    },
  });
  result = await scanAjaxEvidence('unused', productId, timeout.value);
  assert.equal(result.report.outcome, 'inconclusive');
  assert.equal(result.report.reasonCode, 'timeout');

  const malformed = dependencies({ fetched: fetchResult(new TextEncoder().encode('{')) });
  result = await scanAjaxEvidence('unused', productId, malformed.value);
  assert.equal(result.report.reasonCode, 'malformed_json');
  assert.equal('body' in result.report && typeof result.report.body, 'object');
  assert.doesNotMatch(JSON.stringify(result.report), /"rawResponse"|"rawBody"/);
});

test('reuses hardened storage with an ajax filename and secure ordering', async () => {
  const fixture = dependencies();
  const result = await scanAjaxEvidence('unused', productId, fixture.value);
  const calls = [];
  let contents = '';
  const storage = {
    platform: 'win32',
    async makeDirectory(path) { calls.push(['mkdir', path]); },
    async hardenWindowsAcl(path, target) { calls.push([`acl-${target}`, path]); },
    async openTemporary(path) {
      calls.push(['open', path]);
      return {
        async write(value) { calls.push(['write']); contents = value; },
        async sync() { calls.push(['sync']); },
        async close() { calls.push(['close']); },
      };
    },
    async moveFile(from, to) { calls.push(['rename', from, to]); },
    async removeFile(path) { calls.push(['remove', path]); },
  };
  const path = await writeAjaxEvidence('C:\\Private', result.report, storage);
  assert.deepEqual(calls.map(call => call[0]), [
    'mkdir', 'acl-directory', 'open', 'acl-file', 'write', 'sync', 'close', 'rename',
  ]);
  assert.match(path, /ajax-[0-9a-f-]+\.json$/);
  assert.doesNotMatch(contents, /store\.example|synthetic-credential|raw/i);
});
