import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateStorefront, storefrontCookieHeader, protectedProductUrl, StorefrontAuthenticationError,
} from '../dist/packages/shopify/src/storefront-session.js';
import { extractStorefrontPasswordForm } from '../dist/packages/shopify/src/html-evidence.js';
import { fetchAjaxProduct, deriveAjaxProductTarget } from '../dist/packages/shopify/src/ajax.js';
import { saveStorefrontPassword, storefrontAccessStatus, removeStorefrontPassword } from '../dist/packages/agent/src/storefront-access.js';

const shop = 'synthetic.myshopify.com';
const password = 'synthetic password & + value';
const form = '<form action="/password" method="post"><input type="hidden" value="synthetic_csrf==" name="authenticity_token"><input type="password" name="password"></form>';
function transport({ addresses = [{ address: '8.8.8.8', family: 4 }], login = {}, html = form } = {}) {
  const requests = [];
  return {
    requests,
    dependencies: {
      async resolve() { return addresses; },
      async request(target, address, context) {
        requests.push({ target, address, context });
        return { ok: true, response: context.formBody === undefined ? {
          status: 200, contentType: 'text/html; charset=utf-8', contentEncoding: null,
          body: Buffer.from(html), setCookies: ['csrf=synthetic; Path=/; Secure; HttpOnly'],
        } : {
          status: 302, contentType: 'text/html', contentEncoding: null, body: Buffer.alloc(0),
          location: '/', setCookies: ['storefront_digest=synthetic-session; Path=/; Secure; HttpOnly'],
          ...login,
        } };
      },
    },
  };
}

test('development-store sign-in preserves CSRF and sends the password only in one fixed pinned POST', async () => {
  const fixture = transport();
  const session = await authenticateStorefront(shop, password, fixture.dependencies);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].context.formBody, undefined);
  for (const call of fixture.requests) {
    assert.equal(call.target.url.href, `https://${shop}/password`);
    assert.deepEqual(call.address, { address: '8.8.8.8', family: 4 });
  }
  const posted = new URLSearchParams(fixture.requests[1].context.formBody);
  assert.equal(posted.get('password'), password);
  assert.equal(posted.get('authenticity_token'), 'synthetic_csrf==');
  assert.equal(fixture.requests[1].context.cookie, 'csrf=synthetic');
  assert.equal(session.origin, `https://${shop}`);
  assert.match(storefrontCookieHeader(session, new URL(session.origin)), /storefront_digest=synthetic-session/);
  assert.equal(JSON.stringify(session).includes(password), false);
});

test('legacy storefront password form is supported without a CSRF field', async () => {
  const fixture = transport({ html: '<form method="post" action="/password"><input name="form_type" value="storefront_password"><input name="password" type="password"></form>' });
  await authenticateStorefront(shop, password, fixture.dependencies);
  assert.equal(new URLSearchParams(fixture.requests[1].context.formBody).get('form_type'), 'storefront_password');
});

test('sign-in rejects private/mixed DNS before sending either the password or a request', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
    const fixture = transport({ addresses });
    await assert.rejects(authenticateStorefront(shop, password, fixture.dependencies), StorefrontAuthenticationError);
    assert.equal(fixture.requests.length, 0);
  }
});

test('wrong passwords, challenges, foreign redirects, and foreign cookies fail without leaking responses', async () => {
  for (const login of [
    { status: 200 }, { status: 403 }, { status: 429 },
    { location: 'https://other.myshopify.com/' }, { location: '/password' },
    { setCookies: [] }, { setCookies: ['token=synthetic; Domain=myshopify.com; Path=/'] },
    { setCookies: ['token=synthetic; Path=/account'] },
  ]) {
    const fixture = transport({ login: { ...login, body: Buffer.from(`private response ${password}`) } });
    await assert.rejects(authenticateStorefront(shop, password, fixture.dependencies), error => {
      assert.ok(error instanceof StorefrontAuthenticationError);
      assert.equal(error.message.includes(password), false);
      assert.equal(error.message.includes('private response'), false);
      return true;
    });
    assert.equal(fixture.requests.length, 2);
  }
});

test('sign-in bounds stalled DNS and refuses ambiguous or unsafe password forms before POST', async () => {
  await assert.rejects(authenticateStorefront(shop, password, {
    resolve: () => new Promise(() => {}), request: () => { throw new Error('Unexpected request'); }, observationTimeoutMs: 20,
  }), StorefrontAuthenticationError);
  for (const html of [form + form, form.replace('/password', 'https://attacker.invalid/password'),
    '<script>' + form + '</script>', '<!--' + form + '-->', form.replace('method="post"', 'method="get"')]) {
    const fixture = transport({ html });
    await assert.rejects(authenticateStorefront(shop, password, fixture.dependencies), StorefrontAuthenticationError);
    assert.equal(fixture.requests.length, 1);
  }
  assert.deepEqual(extractStorefrontPasswordForm(form, `https://${shop}`), { authenticityToken: 'synthetic_csrf==' });
});

test('authenticated product requests cannot transmit session cookies to another origin', async () => {
  const session = { origin: `https://${shop}`, cookies: [{ name: 'storefront_digest', value: 'synthetic-session' }] };
  let requests = 0;
  const dependencies = {
    async resolve() { return [{ address: '8.8.8.8', family: 4 }]; },
    async request(_target, _address, context) {
      requests += 1;
      assert.equal(context.cookie, 'storefront_digest=synthetic-session');
      return { ok: true, response: { status: 200, contentType: 'application/json', contentEncoding: null, body: Buffer.from('{}') } };
    },
  };
  const result = await fetchAjaxProduct(deriveAjaxProductTarget(`https://${shop}/products/synthetic`), dependencies, session);
  assert.equal(result.reasonCode, null);
  const refused = await fetchAjaxProduct(deriveAjaxProductTarget('https://other.myshopify.com/products/synthetic'), dependencies, session);
  assert.equal(refused.reasonCode, 'storefront_origin_mismatch');
  assert.equal(requests, 1);
  assert.throws(() => storefrontCookieHeader(session, new URL(`http://${shop}/`)), StorefrontAuthenticationError);
  assert.throws(() => storefrontCookieHeader({ ...session, cookies: [{ name: 'x', value: 'bad\r\nvalue' }] }, new URL(session.origin)), StorefrontAuthenticationError);
});

test('protected URL fallback requires fresh active publication and an exact safe Admin handle', () => {
  const admin = { product: { status: 'ACTIVE', publishedAt: '2026-10-15T11:00:00.000Z', handle: 'synthetic-shoe' } };
  assert.equal(protectedProductUrl(shop, admin), `https://${shop}/products/synthetic-shoe`);
  for (const overrides of [{ status: 'DRAFT' }, { publishedAt: null }, { publishedAt: undefined }, { handle: '../account' }, { handle: 'synthetic?token=x' }]) {
    assert.equal(protectedProductUrl(shop, { product: { ...admin.product, ...overrides } }), null);
  }
});

test('only a verified storefront password is saved, status never returns it, and removal deletes it', async () => {
  let saved = 'previous-synthetic';
  const store = {
    async getToken() { return saved; }, async setToken(_shop, value) { saved = value; },
    async deleteToken() { saved = null; return true; },
  };
  await assert.rejects(saveStorefrontPassword(shop, password, store, async () => { throw new StorefrontAuthenticationError(); }));
  assert.equal(saved, 'previous-synthetic');
  await saveStorefrontPassword(shop, password, store, async (receivedShop, receivedPassword) => {
    assert.equal(receivedShop, shop); assert.equal(receivedPassword, password); return { origin: `https://${shop}`, cookies: [] };
  });
  assert.deepEqual(await storefrontAccessStatus(shop, store), { status: 'stored' });
  assert.equal(await removeStorefrontPassword(shop, store), true);
  assert.deepEqual(await storefrontAccessStatus(shop, store), { status: 'missing' });
});
