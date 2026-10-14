import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, disconnect, readStoredToken } from '../dist/packages/agent/src/auth.js';
import { verifyShopifyToken } from '../dist/packages/shopify/src/admin.js';

const shop = 'example.myshopify.com';
const token = 'synthetic-credential';

function successfulFetch(scopes = ['read_products'], domain = shop) {
  return async (url, options) => {
    assert.equal(url, `https://${shop}/admin/api/2026-10/graphql.json`);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Shopify-Access-Token'], token);
    assert.match(JSON.parse(options.body).query, /currentAppInstallation/);
    return Response.json({
      data: {
        shop: { name: 'Example Shop', myshopifyDomain: domain },
        currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) },
      },
    });
  };
}

function fakeCredentialStore() {
  const tokens = new Map();
  return {
    tokens,
    async getToken(account) { return tokens.get(account) ?? null; },
    async setToken(account, value) { tokens.set(account, value); },
    async deleteToken(account) { return tokens.delete(account); },
  };
}

test('verifies a token against the configured shop and required scopes', async () => {
  const connection = await verifyShopifyToken(shop, ` ${token} `, successfulFetch());
  assert.deepEqual(connection, {
    shopName: 'Example Shop',
    shopDomain: shop,
    grantedScopes: ['read_products'],
  });
});

test('write scopes satisfy the corresponding read requirement', async () => {
  await assert.doesNotReject(() => verifyShopifyToken(
    shop,
    token,
    successfulFetch(['write_products']),
  ));
});

test('rejects invalid, wrong-store, and under-scoped tokens', async () => {
  await assert.rejects(
    () => verifyShopifyToken(shop, token, async () => new Response(null, { status: 401 })),
    /rejected the token/,
  );
  await assert.rejects(
    () => verifyShopifyToken(shop, token, successfulFetch(undefined, 'other.myshopify.com')),
    /belongs to other\.myshopify\.com/,
  );
  await assert.rejects(
    () => verifyShopifyToken(shop, token, successfulFetch([])),
    /read_products/,
  );
});

test('connect stores only a verified token and logout removes it', async () => {
  const store = fakeCredentialStore();
  await connect(shop, ` ${token} `, store, successfulFetch());
  assert.equal(await readStoredToken(shop, store), token);
  assert.equal(await disconnect(shop, store), true);
  await assert.rejects(() => readStoredToken(shop, store), /No Shopify token/);

  store.tokens.set(shop, 'existing-valid-token');
  await assert.rejects(
    () => connect(shop, token, store, async () => new Response(null, { status: 401 })),
    /rejected the token/,
  );
  assert.equal(store.tokens.get(shop), 'existing-valid-token');
});
