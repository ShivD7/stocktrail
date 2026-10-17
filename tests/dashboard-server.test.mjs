import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startDashboardServer } from '../dist/apps/dashboard/server.js';

const incidentId = '11111111-1111-4111-8111-111111111111';
const overview = {
  shop: null,
  monitoredProducts: { selected: 0, active: 0, limit: 10 },
  incidents: { open: 0, resolved: 0, ignored: 0 },
  latestScan: null,
};

function source() {
  return {
    async overview() { return overview; },
    async incidents(status) { return status ? [{ status }] : []; },
    async incident(id) { return id === incidentId ? { id } : null; },
  };
}

function rawRequest(url, options) {
  return new Promise((resolve, reject) => {
    const call = request(url, options, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

test('dashboard server exposes loopback JSON routes with safe headers', async () => {
  const server = await startDashboardServer(source(), { port: 0 });
  try {
    const response = await fetch(`${server.url}/api/overview`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), overview);

    const filtered = await fetch(`${server.url}/api/incidents?status=open`);
    assert.deepEqual(await filtered.json(), [{ status: 'open' }]);
    assert.equal((await fetch(`${server.url}/api/incidents?status=invalid`)).status, 400);
    assert.equal((await fetch(`${server.url}/api/incidents/${incidentId}`)).status, 200);
    assert.equal((await fetch(`${server.url}/api/incidents/22222222-2222-4222-8222-222222222222`)).status, 404);
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /<title>StockTrail<\/title>/);
  } finally {
    await server.close();
  }
});

test('dashboard server rejects non-loopback host headers and mutations', async () => {
  const server = await startDashboardServer(source(), { port: 0 });
  try {
    const invalidHost = await rawRequest(`${server.url}/api/overview`, { headers: { Host: 'attacker.example' } });
    assert.equal(invalidHost.status, 403);
    assert.deepEqual(JSON.parse(invalidHost.body), { error: 'invalid_host' });
    const mutation = await fetch(`${server.url}/api/overview`, { method: 'POST' });
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get('allow'), 'GET');
  } finally {
    await server.close();
  }
});

test('dashboard server redacts data-source errors', async () => {
  const server = await startDashboardServer({
    ...source(),
    async overview() { throw new Error('secret token and private path'); },
  }, { port: 0 });
  try {
    const response = await fetch(`${server.url}/api/overview`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'dashboard_unavailable' });
  } finally {
    await server.close();
  }
});
