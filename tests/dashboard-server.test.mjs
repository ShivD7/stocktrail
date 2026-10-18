import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { isExactDashboardAuthority, startDashboardServer } from '../dist/apps/dashboard/server.js';

const incidentId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const revertId = '44444444-4444-4444-8444-444444444444';
const productId = 'gid://shopify/Product/9000';
const timestamp = '2026-10-16T12:00:00.000Z';
const scoreDistribution = {
  buckets: [
    { minimum: 0, maximum: 19, count: 0 }, { minimum: 20, maximum: 39, count: 0 },
    { minimum: 40, maximum: 59, count: 0 }, { minimum: 60, maximum: 79, count: 1 },
    { minimum: 80, maximum: 100, count: 0 },
  ],
  inconclusive: 0,
};
const product = {
  productGid: productId, title: 'Synthetic product', status: 'ACTIVE', present: true, monitored: true,
  variantCount: 1, inventory: { sellableVariants: 0, unavailableVariants: 1, unknownVariants: 0 },
  latestScan: { id: runId, status: 'complete', completedAt: timestamp }, readinessScore: 70,
  weakestComponent: { id: 'availability_agreement', outcome: 'not_ready', points: 0, weight: 30 },
  openIncidentCount: 1, latestProposal: null, allowedActions: ['unmonitor', 'scan', 'improve'],
};
const incident = {
  id: incidentId, productGid: productId, productTitle: product.title,
  variantGid: 'gid://shopify/ProductVariant/9001', variantLabel: 'Size: One', ruleId: 'ST-001',
  status: 'open', severity: 'medium', firstSeenAt: timestamp, lastSeenAt: timestamp,
  lastEvaluatedAt: timestamp, occurrenceCount: 1, latestReasonCode: 'synthetic_failure',
};
const proposal = {
  id: proposalId, productGid: productId, kind: 'improvement', parentProposalId: null,
  status: 'ready', verificationStatus: 'not_started', sourceEvidenceRunId: runId,
  verificationEvidenceRunId: null,
  changes: [{ field: 'title', before: 'Old', after: 'New', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), displayMode: 'text' }],
  diffs: [{ field: 'title', mode: 'word', parts: [{ kind: 'remove', value: 'Old' }, { kind: 'add', value: 'New' }], truncated: false }],
  validation: { valid: true, reasonCodes: [], warningCodes: [] },
  scores: { current: 70, predicted: 100, verified: null }, createdAt: timestamp, completedAt: null,
  allowedActions: ['reject', 'apply'],
};
const overview = {
  shop: 'example.myshopify.com', monitoredProducts: { selected: 1, active: 1, limit: 10 },
  incidents: { open: 1, resolved: 0, ignored: 0 },
  latestScan: { id: runId, productGid: productId, productTitle: product.title, status: 'complete', completedAt: timestamp, readinessScore: 70 },
  scoreDistribution,
};

function source(overrides = {}) {
  return {
    async overview() { return overview; },
    async products() { return [product]; },
    async product(id) { return id === productId ? { ...product, productUrl: 'https://example.invalid/products/synthetic', descriptionText: 'Synthetic', seo: { title: null, description: null }, readiness: null } : null; },
    async incidents(status) { return !status || status === 'open' ? [incident] : []; },
    async incident(id) {
      return id === incidentId ? {
        ...incident, productUrl: 'https://example.invalid/products/synthetic', latestEvidenceRunId: runId,
        sources: [{ source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1, artifactPath: 'jsonld.json' }],
        comparison: [
          { perspective: 'admin', source: 'admin', outcome: 'observed', reasonCode: null, itemCount: 1 },
          { perspective: 'storefront', source: 'ajax', outcome: 'inconclusive', reasonCode: 'missing', itemCount: 0 },
          { perspective: 'search', source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1 },
        ], testHistory: [],
      } : null;
    },
    async incidentEvidence(id, evidenceSource) {
      if (id !== incidentId || !['jsonld', 'html'].includes(evidenceSource)) return null;
      return evidenceSource === 'html'
        ? { body: Buffer.from('<script>never execute</script>'), mediaType: 'text/html', filename: 'html.html' }
        : { body: Buffer.from('{"synthetic":true}'), mediaType: 'application/json', filename: 'jsonld.json' };
    },
    async proposal(id) { if (id !== proposalId) throw new Error('not found'); return proposal; },
    async connection() { return { shop: overview.shop, configuration: 'ready', credentialStorage: 'stored', catalog: { products: 1, variants: 1, imports: 1 }, monitoring: { selected: 1, active: 1, limit: 10 }, localData: { evidenceRuns: 1, incidents: 1, testRuns: 0, retention: 'manual' } }; },
    async importCatalog() { return { status: 'import-complete', productCount: 1, variantCount: 1, deactivatedProductCount: 0, publishedProductCount: 1, fullSnapshot: true }; },
    async monitoring() { return { selected: 1, active: 1, limit: 10 }; },
    async scan() { return { evidenceRunId: runId, collectionStatus: 'complete', readinessScore: 70 }; },
    async improve() { return { proposalId, guidanceCodes: [] }; },
    async rerun() { return { status: 'passed', passed: 1, failed: 0, inconclusive: 0 }; },
    async reject() { return { proposalId, status: 'rejected', verificationStatus: 'not_started' }; },
    async apply() { return { proposalId, status: 'applied', verification: 'verified', diagnosticOutcome: 'pass', changedFields: ['title'] }; },
    async reconcile() { return { proposalId, status: 'applied', verificationStatus: 'verified' }; },
    async revert() { return { proposalId: revertId, parentProposalId: proposalId, status: 'ready', warningCodes: [] }; },
    ...overrides,
  };
}

function rawRequest(url, options, body = '') {
  return new Promise((resolve, reject) => {
    const call = request(url, options, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: responseBody, headers: response.headers }));
    });
    call.on('error', reject);
    call.end(body);
  });
}

async function post(server, path, body = {}, headers = {}) {
  return fetch(`${server.url}${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Origin: server.url, 'Content-Type': 'application/json', ...headers },
  });
}

test('authority validation accepts only the exact bound IPv4 authority', () => {
  const expected = '127.0.0.1:4173';
  assert.equal(isExactDashboardAuthority(expected, expected), true);
  for (const candidate of [
    null, 'localhost:4173', '127.0.0.1', '127.0.0.1:4174', '127.0.0.1:4173.evil',
    '127.0.0.1:4173:extra', 'user@127.0.0.1:4173', ' 127.0.0.1:4173',
    '127.0.0.1:4173 ', '[127.0.0.1]:4173', '[::1]:4173', '::1:4173',
    '127.0.0.1:4173, attacker.example', '127.0.0.1:http', '127.0.0.1:99999',
  ]) assert.equal(isExactDashboardAuthority(candidate, expected), false, candidate ?? 'null');
});

test('dashboard server exposes every Phase 5 route with strict response and evidence handling', async () => {
  const server = await startDashboardServer(source(), { port: 0 });
  try {
    for (const path of ['/api/overview', '/api/products', `/api/products/${encodeURIComponent(productId)}`, '/api/incidents?status=open', `/api/incidents/${incidentId}`, `/api/proposals/${proposalId}`, '/api/connection']) {
      const response = await fetch(`${server.url}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const evidence = await fetch(`${server.url}/api/incidents/${incidentId}/evidence/jsonld`);
    assert.equal(evidence.status, 200);
    assert.deepEqual(await evidence.json(), { synthetic: true });
    const html = await fetch(`${server.url}/api/incidents/${incidentId}/evidence/html`);
    assert.match(html.headers.get('content-type'), /^text\/plain/);
    assert.match(await html.text(), /never execute/);
    assert.equal((await fetch(`${server.url}/api/evidence/${runId}/jsonld.json`)).status, 404);

    const operations = [
      ['/api/imports', { limit: 50 }], ['/api/monitoring', { productId, action: 'add' }],
      ['/api/scans', { productId }], [`/api/products/${encodeURIComponent(productId)}/improve`, {}],
      [`/api/incidents/${incidentId}/rerun`, {}], [`/api/proposals/${proposalId}/reject`, {}],
      [`/api/proposals/${proposalId}/apply`, { confirmation: `APPLY ${proposalId}`, acknowledgeWarnings: false }],
      [`/api/proposals/${proposalId}/reconcile`, {}], [`/api/proposals/${proposalId}/revert`, {}],
    ];
    for (const [path, body] of operations) {
      const response = await post(server, path, body);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  } finally { await server.close(); }
});

test('server rejects malformed authority, origin, content type, JSON, oversized bodies, and methods', async () => {
  const server = await startDashboardServer(source(), { port: 0 });
  const authority = new URL(server.url).host;
  try {
    const accepted = await rawRequest(`${server.url}/api/overview`, { headers: { Host: authority } });
    assert.equal(accepted.status, 200);
    const duplicateHost = await rawRequest(`${server.url}/api/overview`, {
      headers: ['Host', authority, 'Host', authority],
    });
    assert.ok([400, 403].includes(duplicateHost.status), `duplicate Host returned ${duplicateHost.status}`);
    for (const host of ['localhost:' + new URL(server.url).port, '127.0.0.1', `${authority}.evil`, `${authority}:extra`, `user@${authority}`, '[::1]:' + new URL(server.url).port]) {
      const response = await rawRequest(`${server.url}/api/overview`, { headers: { Host: host } });
      assert.equal(response.status, 403, host);
      assert.deepEqual(JSON.parse(response.body), { error: 'invalid_host' });
    }
    for (const origin of [undefined, 'null', `${server.url}/`, server.url.replace('127.0.0.1', 'localhost'), `${server.url}.evil`, `https://${authority}`]) {
      const headers = { 'Content-Type': 'application/json' };
      if (origin !== undefined) headers.Origin = origin;
      const response = await fetch(`${server.url}/api/imports`, { method: 'POST', headers, body: '{"limit":1}' });
      assert.equal(response.status, 403, String(origin));
      assert.deepEqual(await response.json(), { error: 'invalid_origin' });
    }
    const duplicateOrigin = await rawRequest(`${server.url}/api/imports`, {
      method: 'POST', headers: ['Host', authority, 'Origin', server.url, 'Origin', server.url, 'Content-Type', 'application/json'],
    }, '{"limit":1}');
    assert.equal(duplicateOrigin.status, 403);

    assert.deepEqual(await (await fetch(`${server.url}/api/imports`, { method: 'POST', headers: { Origin: server.url }, body: '{}' })).json(), { error: 'unsupported_media_type' });
    assert.deepEqual(await (await fetch(`${server.url}/api/imports`, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'text/plain' }, body: '{}' })).json(), { error: 'unsupported_media_type' });
    assert.deepEqual(await (await fetch(`${server.url}/api/imports`, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: '{' })).json(), { error: 'invalid_request' });
    assert.deepEqual(await (await post(server, '/api/imports', { limit: 1, unknown: true })).json(), { error: 'invalid_request' });
    const oversized = await fetch(`${server.url}/api/imports`, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1, padding: 'x'.repeat(17_000) }) });
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: 'body_too_large' });
    const put = await fetch(`${server.url}/api/overview`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');
  } finally { await server.close(); }
});

test('per-operation guards reject concurrent import, scan, rerun, apply, and reconcile work', async () => {
  const gates = new Map();
  const calls = {
    importCatalog: () => ({ status: 'import-complete', productCount: 1, variantCount: 1, deactivatedProductCount: 0, publishedProductCount: 1, fullSnapshot: true }),
    scan: () => ({ evidenceRunId: runId, collectionStatus: 'complete', readinessScore: 70 }),
    rerun: () => ({ status: 'passed', passed: 1, failed: 0, inconclusive: 0 }),
    apply: () => ({ proposalId, status: 'applied', verification: 'verified', diagnosticOutcome: 'pass', changedFields: ['title'] }),
    reconcile: () => ({ proposalId, status: 'applied', verificationStatus: 'verified' }),
  };
  const overrides = Object.fromEntries(Object.entries(calls).map(([name, result]) => [name, async () => new Promise(resolve => gates.set(name, () => resolve(result())))]));
  const server = await startDashboardServer(source(overrides), { port: 0 });
  try {
    const cases = [
      ['importCatalog', '/api/imports', { limit: 1 }], ['scan', '/api/scans', { productId }],
      ['rerun', `/api/incidents/${incidentId}/rerun`, {}],
      ['apply', `/api/proposals/${proposalId}/apply`, { confirmation: `APPLY ${proposalId}`, acknowledgeWarnings: false }],
      ['reconcile', `/api/proposals/${proposalId}/reconcile`, {}],
    ];
    for (const [name, path, body] of cases) {
      const first = post(server, path, body);
      while (!gates.has(name)) await new Promise(resolve => setImmediate(resolve));
      const second = await post(server, path, body);
      assert.equal(second.status, 409, name);
      assert.deepEqual(await second.json(), { error: 'operation_in_progress' });
      gates.get(name)();
      gates.delete(name);
      assert.equal((await first).status, 200, name);
    }
  } finally { await server.close(); }
});

test('dashboard server redacts data-source errors', async () => {
  const server = await startDashboardServer(source({
    async overview() { throw new Error('secret token and C:\\private\\path'); },
  }), { port: 0 });
  try {
    const response = await fetch(`${server.url}/api/overview`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'dashboard_unavailable' });
  } finally { await server.close(); }
});
