import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  buildPinnedRequestOptions,
  createPinnedLookup,
  deriveAjaxProductTarget,
  deriveHtmlProductTarget,
  fetchAjaxProduct,
  fetchHtmlProduct,
  InvalidAjaxProductUrlError,
  isPublicNetworkAddress,
  normalizeAjaxProduct,
} from '../dist/packages/shopify/src/ajax.js';

const validUrl = 'https://store.example/en-ca/products/synthetic-handle';

function bytes(value) {
  return new TextEncoder().encode(value);
}

function rawResponse(overrides = {}) {
  return {
    ok: true,
    response: {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      contentEncoding: null,
      body: bytes('{"id":1,"handle":"synthetic-handle","variants":[]}'),
      ...overrides,
    },
  };
}

test('derives the Ajax URL while preserving a safe locale prefix', () => {
  const target = deriveAjaxProductTarget(validUrl);
  assert.equal(target.url.href, 'https://store.example/en-ca/products/synthetic-handle.js');
  assert.equal(target.handle, 'synthetic-handle');
  assert.equal(target.localePath, '/en-ca');
  assert.equal(deriveAjaxProductTarget('https://store.example/products/item').localePath, null);
  assert.equal(deriveHtmlProductTarget(validUrl).url.href, validUrl);

  for (const value of [
    'http://store.example/products/item',
    'https://user@store.example/products/item',
    'https://store.example:444/products/item',
    'https://127.0.0.1/products/item',
    'https://[::1]/products/item',
    'https://[2606:4700:4700::1111]/products/item',
    'https://store.example/products/item?view=x',
    'https://store.example/products/item#fragment',
    'https://store.example/products/item/',
    'https://store.example/products/one/products/two',
    'https://store.example/collections/item',
  ]) {
    assert.throws(() => deriveAjaxProductTarget(value), InvalidAjaxProductUrlError);
  }
});

test('rejects private and reserved IPv4 and IPv6 addresses', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1',
    'fc00::1', 'ff02::1', '2001:db8::1', '2002::1', '::ffff:127.0.0.1',
  ]) assert.equal(isPublicNetworkAddress(address), false, address);
  assert.equal(isPublicNetworkAddress('8.8.8.8'), true);
  assert.equal(isPublicNetworkAddress('2606:4700:4700::1111'), true);
});

test('allows only IANA-allocated IPv6 unicast prefixes minus special-purpose exclusions', () => {
  const allocatedBoundaries = [
    ['2001:200::', '2001:3ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:400::', '2001:5ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:600::', '2001:7ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:800::', '2001:bff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:c00::', '2001:dff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:e00::', '2001:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:1200::', '2001:13ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:1400::', '2001:17ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:1800::', '2001:19ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:1a00::', '2001:1bff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:1c00::', '2001:1fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:2000::', '2001:3fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4000::', '2001:41ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4200::', '2001:43ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4400::', '2001:45ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4600::', '2001:47ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4800::', '2001:49ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4a00::', '2001:4bff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:4c00::', '2001:4dff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:5000::', '2001:5fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:8000::', '2001:9fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:a000::', '2001:afff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2001:b000::', '2001:bfff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2003::', '2003:3fff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2400::', '240f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2410::', '241f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2600::', '260f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2610::', '2610:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2620::', '2620:1ff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2630::', '263f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2800::', '280f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2a00::', '2a0f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2a10::', '2a1f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    ['2c00::', '2c0f:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ];
  for (const [first, last] of allocatedBoundaries) {
    assert.equal(isPublicNetworkAddress(first), true, first);
    assert.equal(isPublicNetworkAddress(last), true, last);
  }

  const reservedOrSpecial = [
    '1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '4000::',
    '2000::',
    '2000:0000:0000:0000:0000:0000:0000:0001',
    '2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001::1',
    '2001:0000:0000:0000:0000:0000:0000:0001',
    '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:2::1',
    '2001:0002:0000:0000:0000:0000:0000:0001',
    '2001:db8::1',
    '2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff',
    '2002::1',
    '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2003:4000::',
    '23ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2420::',
    '25ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2610:200::',
    '2611::',
    '2620:200::',
    '2621::',
    '2620:4f:8000::1',
    '2620:004f:8000:ffff:ffff:ffff:ffff:ffff',
    '2640::',
    '27ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2810::',
    '29ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2a20::',
    '2bff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2c10::',
    '2cff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2d00::',
    '3ffe::1',
    '3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '3fff::1',
    '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '3fff:1000::',
    '3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:1000::',
    '2001:11ff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:4e00::',
    '2001:4fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:6000::',
    '2001:7fff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:c000::',
    '2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    '::ffff:8.8.8.8',
    '0:0:0:0:0:ffff:0808:0808',
    '::ffff:192.168.1.1',
    '2606:4700:4700::1111%1',
  ];
  for (const address of reservedOrSpecial) assert.equal(isPublicNetworkAddress(address), false, address);

  const representativePublic = [
    '2001:200::1',
    '2001:400::1',
    '2001:600::1',
    '2001:1200::1',
    '2001:4200::1',
    '2001:db7:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db9::',
    '2620:4f:7fff:ffff:ffff:ffff:ffff:ffff',
    '2620:4f:8001::',
    '2404:6800:4000::200e',
    '2404:6800:4000:0000:0000:0000:0000:200e',
    '2606:4700:4700::1111',
    '2606:4700:4700:0000:0000:0000:0000:1111',
    '2800:3f0:4001::200e',
    '2a00:1450:4001::200e',
    '2c0f:f248:1::1',
  ];
  for (const address of representativePublic) assert.equal(isPublicNetworkAddress(address), true, address);
});

test('pins lookup and sends only minimal cookieless GET headers', () => {
  const target = deriveAjaxProductTarget(validUrl);
  const address = { address: '8.8.8.8', family: 4 };
  const options = buildPinnedRequestOptions(target, address);
  assert.equal(options.method, 'GET');
  assert.equal(options.servername, 'store.example');
  assert.deepEqual(options.headers, { Accept: 'application/json', 'Accept-Encoding': 'identity' });
  assert.doesNotMatch(JSON.stringify(options.headers), /authorization|cookie|shopify|customer|referer/i);
  let result;
  createPinnedLookup('store.example', address)('store.example', {}, (...args) => { result = args; });
  assert.deepEqual(result, [null, '8.8.8.8', 4]);
  createPinnedLookup('store.example', address)('store.example', { all: true }, (...args) => { result = args; });
  assert.deepEqual(result, [null, [{ address: '8.8.8.8', family: 4 }]]);
});

test('actual Node HTTPS path connects only to the pinned local listener', async () => {
  let connections = 0;
  let firstByte = null;
  let sniObserved = false;
  const server = createServer(socket => {
    connections += 1;
    socket.once('data', chunk => {
      firstByte = chunk[0] ?? null;
      sniObserved = chunk.includes(Buffer.from('pinned.test'));
      socket.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    const target = {
      url: new URL(`https://pinned.test:${address.port}/products/item.js`),
      handle: 'item',
      localePath: null,
    };
    const options = {
      ...buildPinnedRequestOptions(target, { address: '127.0.0.1', family: 4 }),
      rejectUnauthorized: false,
    };
    await new Promise((resolve, reject) => {
      const request = httpsRequest(target.url, options);
      assert.equal(request.getHeader('host'), `pinned.test:${address.port}`);
      request.once('error', resolve);
      request.setTimeout(2_000, () => request.destroy(new Error('Local integration test timed out.')));
      request.once('response', () => reject(new Error('The raw socket listener unexpectedly completed TLS.')));
      request.end();
    });
    assert.equal(options.servername, 'pinned.test');
    assert.equal(connections, 1);
    assert.equal(firstByte, 22, 'listener should receive a TLS handshake, not plaintext HTTP');
    assert.equal(sniObserved, true, 'TLS ClientHello should preserve the original hostname as SNI');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('rejects any unsafe DNS result and pins a validated public result', async () => {
  const target = deriveAjaxProductTarget(validUrl);
  let requests = 0;
  let pinned;
  let result = await fetchAjaxProduct(target, {
    async resolve() { return [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]; },
    async request(_target, address) { requests += 1; pinned = address; return rawResponse(); },
  });
  assert.equal(result.reasonCode, 'unsafe_network_address');
  assert.equal(requests, 0);

  result = await fetchAjaxProduct(target, {
    async resolve() { return [{ address: '8.8.8.8', family: 6 }]; },
    async request() { requests += 1; return rawResponse(); },
  });
  assert.equal(result.reasonCode, 'unsafe_network_address');
  assert.equal(requests, 0);

  result = await fetchAjaxProduct(target, {
    async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
    async request(_target, address) { requests += 1; pinned = address; return rawResponse(); },
  });
  assert.equal(result.reasonCode, null);
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
});

test('uses one total deadline across DNS and HTTPS and ignores late work', async () => {
  const target = deriveAjaxProductTarget(validUrl);
  let releaseDns;
  let requests = 0;
  const stalledDns = fetchAjaxProduct(target, {
    observationTimeoutMs: 15,
    async resolve() { return new Promise(resolve => { releaseDns = resolve; }); },
    async request() { requests += 1; return rawResponse(); },
  });
  let result = await stalledDns;
  assert.equal(result.reasonCode, 'timeout');
  assert.equal(requests, 0);
  releaseDns([{ address: '8.8.8.8', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);

  let now = 1_000;
  let requestBudget;
  result = await fetchAjaxProduct(target, {
    observationTimeoutMs: 1_000,
    now: () => now,
    async resolve() { now += 400; return [{ address: '8.8.8.8', family: 4 }]; },
    async request(_target, _address, context) { requestBudget = context.timeoutMs; return rawResponse(); },
  });
  assert.equal(result.reasonCode, null);
  assert.equal(requestBudget, 600);

  let rejectLateRequest;
  let requestSignal;
  result = await fetchAjaxProduct(target, {
    observationTimeoutMs: 15,
    async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
    async request(_target, _address, context) {
      requestSignal = context.signal;
      return new Promise((_resolve, reject) => { rejectLateRequest = reject; });
    },
  });
  assert.equal(result.reasonCode, 'timeout');
  assert.equal(requestSignal.aborted, true);
  rejectLateRequest(new Error('late synthetic rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.reasonCode, 'timeout');
});

test('returns fixed outcomes for redirects, statuses, content type, timeout, transport, and body cap', async () => {
  const target = deriveAjaxProductTarget(validUrl);
  const cases = [
    [rawResponse({ status: 302 }), 'redirect_observed'],
    [rawResponse({ status: 401 }), 'http_unauthorized'],
    [rawResponse({ status: 403 }), 'http_unauthorized'],
    [rawResponse({ status: 404 }), 'http_not_found'],
    [rawResponse({ status: 503 }), 'http_status'],
    [rawResponse({ status: 0 }), 'http_status'],
    [rawResponse({ contentType: 'text/html' }), 'non_json_content_type'],
    [{ ok: false, reasonCode: 'timeout' }, 'timeout'],
    [{ ok: false, reasonCode: 'transport_failure' }, 'transport_failure'],
    [rawResponse({ body: new Uint8Array(5 * 1024 * 1024 + 1) }), 'body_too_large'],
  ];
  for (const [requestResult, expected] of cases) {
    const result = await fetchAjaxProduct(target, {
      async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
      async request() { return requestResult; },
    });
    assert.equal(result.reasonCode, expected);
    assert.equal(result.body, null);
  }
});

test('bounds and validates compressed response bodies', async () => {
  const target = deriveAjaxProductTarget(validUrl);
  const request = async response => fetchAjaxProduct(target, {
    async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
    async request() { return rawResponse(response); },
  });
  const source = bytes('{"id":1,"handle":"synthetic-handle","variants":[]}');
  let result = await request({ body: gzipSync(source), contentEncoding: 'gzip' });
  assert.equal(result.reasonCode, null);
  assert.deepEqual(Buffer.from(result.body), Buffer.from(source));

  result = await request({ body: source, contentEncoding: 'compress' });
  assert.equal(result.reasonCode, 'unsupported_content_encoding');
  result = await request({ body: bytes('not-gzip'), contentEncoding: 'gzip' });
  assert.equal(result.reasonCode, 'body_decode_failed');
  result = await request({ body: gzipSync(new Uint8Array(5 * 1024 * 1024 + 1)), contentEncoding: 'gzip' });
  assert.equal(result.reasonCode, 'body_too_large');
});

test('HTML collection inherits pinned transport and enforces 200 text/html with a compatible charset', async () => {
  const target = deriveHtmlProductTarget(validUrl);
  const request = async response => fetchHtmlProduct(target, {
    async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
    async request(_target, address) {
      assert.deepEqual(address, { address: '8.8.8.8', family: 4 });
      return rawResponse(response);
    },
  });
  let result = await request({ status: 200, contentType: 'text/html; charset=UTF-8', body: bytes('<html></html>') });
  assert.equal(result.reasonCode, null);
  result = await request({ status: 201, contentType: 'text/html' });
  assert.equal(result.reasonCode, 'http_status');
  result = await request({ status: 200, contentType: 'application/xhtml+xml' });
  assert.equal(result.reasonCode, 'non_html_content_type');
  result = await request({ status: 200, contentType: 'text/html; charset=iso-8859-1' });
  assert.equal(result.reasonCode, 'unsupported_charset');
});

test('parses UnsignedInt64 identities losslessly and ignores undocumented inventory fields', () => {
  const source = `{
    "id": 9007199254740993,
    "handle": "synthetic-handle",
    "available": true,
    "requires_selling_plan": false,
    "variants": [{
      "id": 9007199254740995,
      "available": false,
      "inventory_management": "shopify",
      "requires_selling_plan": true,
      "inventory_policy": "continue",
      "inventory_quantity": 999,
      "selling_plan_allocations": [{
        "selling_plan_id": 9007199254740997,
        "selling_plan_group_id": 9007199254740999
      }]
    }]
  }`;
  const result = normalizeAjaxProduct(bytes(source));
  assert.equal(result.ok, true);
  assert.equal(result.product.id, '9007199254740993');
  assert.equal(result.product.variants[0].id, '9007199254740995');
  assert.deepEqual(result.product.variants[0].sellingPlanAllocations, [{
    sellingPlanId: '9007199254740997',
    sellingPlanGroupId: '9007199254740999',
  }]);
  assert.equal('inventoryPolicy' in result.product.variants[0], false);
  assert.equal('inventoryQuantity' in result.product.variants[0], false);
});

test('rejects malformed identities, duplicate variants, and more than 250 variants', () => {
  const malformed = normalizeAjaxProduct(bytes('{"id":1.5,"handle":"item","variants":[]}'));
  assert.deepEqual(malformed, { ok: false, reasonCode: 'malformed_ajax_contract' });
  const duplicate = normalizeAjaxProduct(bytes(
    '{"id":1,"handle":"item","variants":[{"id":2},{"id":2}]}',
  ));
  assert.deepEqual(duplicate, { ok: false, reasonCode: 'duplicate_ajax_variant_id' });
  const variants = Array.from({ length: 251 }, (_, index) => `{"id":${index + 1}}`).join(',');
  const excessive = normalizeAjaxProduct(bytes(`{"id":1,"handle":"item","variants":[${variants}]}`));
  assert.deepEqual(excessive, { ok: false, reasonCode: 'variant_limit_exceeded' });
});
