import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { seedStorefrontSession } from '../dist/packages/shopify/src/storefront-session.js';
import {
  collectBrowserEvidence,
  observeDawnVariant,
} from '../dist/packages/shopify/src/browser.js';

const variant = {
  id: 'gid://shopify/ProductVariant/701', legacyResourceId: '701',
  selectedOptions: [{ name: 'Size', value: 'One' }], inventoryPolicy: 'DENY',
  inventoryQuantity: 1, sellableOnlineQuantity: 1, updatedAt: '2026-10-15T10:00:00.000Z',
  inventoryItem: { id: 'gid://shopify/InventoryItem/701', tracked: true, updatedAt: '2026-10-15T09:00:00.000Z' },
};
const ajaxVariant = {
  id: '701', available: true, inventoryManagement: 'shopify', requiresSellingPlan: false,
  sellingPlanAllocations: [],
};

test('authenticated Dawn observation receives only host-scoped cookies and a subsequent fresh context is anonymous', async () => {
  const browser = await chromium.launch({ headless: true });
  const origin = 'https://synthetic.myshopify.com';
  const session = { origin, cookies: [{ name: 'storefront_digest', value: 'synthetic-session' }] };
  const target = new URL(`${origin}/products/synthetic`);
  const requests = [];
  try {
    for (const authenticated of [true, false]) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        if (authenticated) await seedStorefrontSession(context, target, session);
        await context.route('**/*', async route => {
          const cookie = await route.request().headerValue('cookie');
          requests.push({ cookie, method: route.request().method() });
          await route.fulfill({ contentType: 'text/html', body: '<form method="post" action="/cart/add"><input name="id" value="701" type="hidden"><button name="add" type="submit">Add to cart</button></form>' });
        });
        const observed = await observeDawnVariant(context, target, variant, ajaxVariant, false);
        assert.equal(observed.outcome, 'observed');
        const otherHost = await context.cookies('https://other.myshopify.com/');
        assert.equal(otherHost.length, 0);
      } finally { await context.close(); }
    }
    assert.equal(requests[0].cookie, 'storefront_digest=synthetic-session');
    assert.equal(requests[1].cookie, null);
    assert.equal(requests.every(request => request.method === 'GET'), true);
  } finally { await browser.close(); }
});

async function withFixture(handler) {
  let cartItems = [];
  const requests = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://fixture.invalid');
    requests.push(`${request.method} ${requestUrl.pathname}`);
    if (requestUrl.pathname === '/cart.js') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: cartItems }));
      return;
    }
    if (requestUrl.pathname === '/cart/clear.js') {
      request.resume();
      cartItems = [];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [] }));
      return;
    }
    if (requestUrl.pathname === '/cart/add') {
      request.resume();
      cartItems = [{ variant_id: 701, quantity: 1 }];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ variant_id: 701, quantity: 1 }));
      return;
    }
    const disabled = requestUrl.searchParams.get('disabled') === '1';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><body>
      <form action="/cart/add" method="post">
        <input type="hidden" name="id" value="701">
        <button name="add" type="submit" ${disabled ? 'disabled aria-disabled="true"' : ''}>Add to cart</button>
      </form>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await handler(`http://127.0.0.1:${address.port}/products/synthetic-item`, () => requests);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('Dawn observer records exact enabled and disabled controls from a loopback fixture', async () => {
  await withFixture(async (url, requests) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const enabledContext = await browser.newContext({ serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      const enabled = await observeDawnVariant(enabledContext, new URL(url), variant, ajaxVariant, false);
      await enabledContext.close();
      assert.equal(enabled.outcome, 'observed');
      assert.equal(enabled.selectedLegacyVariantId, '701');
      assert.equal(enabled.controlState, 'enabled');
      assert.equal(enabled.storefrontPurchasable, true);

      const disabledContext = await browser.newContext({ serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      const disabled = await observeDawnVariant(disabledContext, new URL(`${url}?disabled=1`), variant, ajaxVariant, false);
      await disabledContext.close();
      assert.equal(disabled.outcome, 'observed');
      assert.equal(disabled.controlState, 'disabled');
      assert.equal(disabled.storefrontPurchasable, false);

      const cartContext = await browser.newContext({ serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      const cart = await observeDawnVariant(cartContext, new URL(url), variant, ajaxVariant, true);
      assert.equal(cart.outcome, 'observed', `${JSON.stringify(cart)} ${JSON.stringify(requests())}`);
      assert.equal(cart.cartOutcome, 'succeeded');
      assert.equal(cart.storefrontPurchasable, true);
      const cleaned = await cartContext.request.get(new URL('/cart.js', url).href);
      assert.deepEqual((await cleaned.json()).items, []);
      await cartContext.close();
    } finally {
      await browser.close();
    }
  });
});

test('browser collection refuses loopback targets before Chromium launch', async () => {
  const admin = {
    schemaVersion: 1, mode: 'admin_only', source: 'shopify_admin_graphql',
    productId: 'gid://shopify/Product/700',
    observationWindow: { startedAt: '2026-10-15T11:59:58.000Z', completedAt: '2026-10-15T11:59:59.000Z' },
    apiVersion: { requested: '2026-10', response: '2026-10' }, pageCount: 1, complete: true,
    limitations: ['Synthetic.'],
    product: {
      id: 'gid://shopify/Product/700', status: 'ACTIVE',
      onlineStoreUrl: 'https://localhost/products/synthetic-item',
      updatedAt: '2026-10-15T11:00:00.000Z', variants: [variant],
    },
  };
  const ajax = { id: '700', handle: 'synthetic-item', available: true, requiresSellingPlan: false, variants: [ajaxVariant] };
  const result = await collectBrowserEvidence(admin, ajax, false);
  assert.equal(result.outcome, 'inconclusive');
  assert.equal(result.reasonCode, 'unsafe_network_address');
  assert.deepEqual(result.observations, []);
});
