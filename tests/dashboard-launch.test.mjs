import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchDashboard, parseDashboardPort } from '../dist/apps/dashboard/launch.js';

test('dashboard launcher validates explicit loopback ports', () => {
  assert.equal(parseDashboardPort(undefined), 4173);
  assert.equal(parseDashboardPort('1'), 1);
  assert.equal(parseDashboardPort('65535'), 65535);
  for (const value of ['', '0', '65536', '4.5', '-1', 'nope']) {
    assert.throws(() => parseDashboardPort(value), /whole number from 1 to 65535/);
  }
});

test('dashboard launcher wires configured shop and optional browser opening', async () => {
  const events = [];
  const server = { url: 'http://127.0.0.1:4321', async close() {} };
  const dependencies = {
    async readShop(directory) { events.push(['config', directory]); return 'example.myshopify.com'; },
    createDataSource(directory, shop) {
      events.push(['source', directory, shop]);
      return { overview() {}, incidents() {}, incident() {} };
    },
    async startServer(_data, options) { events.push(['server', options.port]); return server; },
    openUrl(url) { events.push(['open', url]); },
  };
  assert.equal(await launchDashboard('/safe/data', { port: '4321' }, dependencies), server);
  assert.deepEqual(events, [
    ['config', '/safe/data'],
    ['source', '/safe/data', 'example.myshopify.com'],
    ['server', 4321],
    ['open', 'http://127.0.0.1:4321'],
  ]);
  events.length = 0;
  await launchDashboard('/safe/data', { open: false }, dependencies);
  assert.equal(events.some(([event]) => event === 'open'), false);
});
