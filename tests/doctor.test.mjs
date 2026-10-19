import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSetup } from '../dist/packages/agent/src/doctor.js';

function dependencies(overrides = {}) {
  return {
    readConfig: async () => ({ version: 1, shop: 'example.myshopify.com' }),
    checkDataDirectory: async () => undefined,
    checkDatabase: async () => undefined,
    readToken: async () => ['shp', 'at_', 'private_canary_value'].join(''),
    verify: async () => ({
      shopName: 'Private store name',
      shopDomain: 'example.myshopify.com',
      grantedScopes: ['read_products'],
    }),
    ...overrides,
  };
}

test('offline doctor checks local health without reading credentials', async () => {
  let tokenReads = 0;
  const checks = await diagnoseSetup('unused', false, dependencies({
    readToken: async () => { tokenReads += 1; return 'not-used'; },
  }));
  assert.equal(tokenReads, 0);
  assert.deepEqual(checks.map(check => check.label), ['Node', 'Data directory', 'Database', 'Shop', 'Connection']);
  assert.match(checks.at(-1).detail, /doctor --live/);
});

test('live doctor reports capabilities without returning token or private store name', async () => {
  const checks = await diagnoseSetup('unused', true, dependencies());
  const output = JSON.stringify(checks);
  assert.match(output, /Shopify token verified/);
  assert.match(output, /scans remain read-only/);
  assert.doesNotMatch(output, /shpat_|Private store name|private_canary/i);

  const writable = await diagnoseSetup('unused', true, dependencies({
    verify: async () => ({ shopName: 'Private', shopDomain: 'example.myshopify.com', grantedScopes: ['write_products'] }),
  }));
  assert.match(JSON.stringify(writable), /product writes available with explicit approval/);
});

test('live doctor requires a configured shop', async () => {
  await assert.rejects(
    diagnoseSetup('unused', true, dependencies({ readConfig: async () => ({ version: 1, shop: null }) })),
    /Configure a shop/,
  );
});
