import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAdminProductEvidence,
  ShopifyProductUnavailableError,
} from '../dist/packages/shopify/src/admin-evidence.js';
import {
  ShopifyAdminClient,
  ShopifyResponseError,
} from '../dist/packages/shopify/src/admin-client.js';

const shop = 'example.myshopify.com';
const credential = 'synthetic-credential';
const productId = 'gid://shopify/Product/100';

function variant(id, overrides = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    legacyResourceId: String(id),
    selectedOptions: [{ name: 'Size', value: 'Synthetic' }],
    inventoryPolicy: 'DENY',
    inventoryQuantity: 4,
    sellableOnlineQuantity: 3,
    updatedAt: '2026-10-15T10:00:00.000Z',
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      tracked: true,
      updatedAt: '2026-10-15T09:00:00.000Z',
    },
    ...overrides,
  };
}

function product(nodes, pageInfo, overrides = {}) {
  return {
    id: productId,
    status: 'ACTIVE',
    onlineStoreUrl: 'https://example.invalid/products/synthetic',
    updatedAt: '2026-10-15T11:00:00.000Z',
    variants: { nodes, pageInfo },
    ...overrides,
  };
}

function response(data, apiVersion = '2026-10') {
  const headers = apiVersion === null ? {} : { 'x-shopify-api-version': apiVersion };
  return Response.json({ data }, { headers });
}

function clock(...values) {
  let index = 0;
  return () => new Date(values[index++] ?? values.at(-1));
}

test('reads a complete, minimal Admin-only evidence report', async () => {
  const requests = [];
  const client = new ShopifyAdminClient(shop, credential, async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return response({ product: product([variant('1')], { hasNextPage: false, endCursor: null }) });
  });
  const report = await readAdminProductEvidence(
    client,
    productId,
    clock('2026-10-15T12:00:00.000Z', '2026-10-15T12:00:01.000Z'),
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].variables.productId, productId);
  assert.equal(requests[0].variables.first, 100);
  assert.equal(requests[0].variables.after, null);
  assert.doesNotMatch(requests[0].query, /\b(title|description|handle|sku|media|price)\b/i);
  assert.deepEqual(report.observationWindow, {
    startedAt: '2026-10-15T12:00:00.000Z',
    completedAt: '2026-10-15T12:00:01.000Z',
  });
  assert.deepEqual(report.apiVersion, { requested: '2026-10', response: '2026-10' });
  assert.equal(report.pageCount, 1);
  assert.equal(report.complete, true);
  assert.equal(report.product.variants.length, 1);
  assert.match(report.limitations.join(' '), /Admin API evidence only/);
  assert.doesNotMatch(JSON.stringify(report), /request.?id|query.?cost|synthetic-credential/i);
});

test('paginates variants at 100 and preserves consistent product evidence', async () => {
  const pages = [
    response({ product: product([variant('1')], { hasNextPage: true, endCursor: 'cursor-a' }) }),
    response({ product: product([variant('2')], { hasNextPage: false, endCursor: 'cursor-b' }) }),
  ];
  const afterValues = [];
  const client = new ShopifyAdminClient(shop, credential, async (_url, options) => {
    afterValues.push(JSON.parse(options.body).variables.after);
    return pages.shift();
  });
  const report = await readAdminProductEvidence(client, productId);
  assert.deepEqual(afterValues, [null, 'cursor-a']);
  assert.equal(report.pageCount, 2);
  assert.deepEqual(report.product.variants.map(item => item.id), [
    'gid://shopify/ProductVariant/1',
    'gid://shopify/ProductVariant/2',
  ]);
});

test('returns typed missing or inaccessible product behavior', async () => {
  const client = new ShopifyAdminClient(shop, credential, async () => response({ product: null }));
  await assert.rejects(
    () => readAdminProductEvidence(client, productId),
    ShopifyProductUnavailableError,
  );
});

test('rejects malformed, null, and repeated pagination cursors', async () => {
  const cases = [
    [response({ product: { id: productId } })],
    [response({ product: product([], { hasNextPage: true, endCursor: null }) })],
    [
      response({ product: product([], { hasNextPage: true, endCursor: 'cursor-a' }) }),
      response({ product: product([], { hasNextPage: true, endCursor: 'cursor-a' }) }),
    ],
  ];
  for (const pages of cases) {
    const client = new ShopifyAdminClient(shop, credential, async () => pages.shift());
    await assert.rejects(() => readAdminProductEvidence(client, productId), ShopifyResponseError);
  }
});

test('rejects duplicate variants and product fields that change between pages', async () => {
  const duplicatePages = [
    response({ product: product([variant('1')], { hasNextPage: true, endCursor: 'cursor-a' }) }),
    response({ product: product([variant('1')], { hasNextPage: false, endCursor: null }) }),
  ];
  const duplicateClient = new ShopifyAdminClient(shop, credential, async () => duplicatePages.shift());
  await assert.rejects(() => readAdminProductEvidence(duplicateClient, productId), ShopifyResponseError);

  for (const changedField of [
    { status: 'DRAFT' },
    { onlineStoreUrl: null },
    { updatedAt: '2026-10-15T11:00:01.000Z' },
  ]) {
    const inconsistentPages = [
      response({ product: product([], { hasNextPage: true, endCursor: 'cursor-a' }) }),
      response({ product: product([], { hasNextPage: false, endCursor: null }, changedField) }),
    ];
    const inconsistentClient = new ShopifyAdminClient(shop, credential, async () => inconsistentPages.shift());
    await assert.rejects(
      () => readAdminProductEvidence(inconsistentClient, productId),
      /inconsistent product evidence/,
    );
  }
});

test('rejects an invalid product GID before the transport boundary', async () => {
  let requests = 0;
  const client = new ShopifyAdminClient(shop, credential, async () => {
    requests += 1;
    return response({ product: null });
  });
  await assert.rejects(() => readAdminProductEvidence(client, 'not-a-gid'), /Shopify Product GID/);
  assert.equal(requests, 0);
});

test('bounds a non-terminating unique-cursor sequence', async () => {
  let requests = 0;
  const client = new ShopifyAdminClient(shop, credential, async () => {
    requests += 1;
    return response({ product: product([], {
      hasNextPage: true,
      endCursor: `cursor-${requests}`,
    }) });
  });
  await assert.rejects(() => readAdminProductEvidence(client, productId), ShopifyResponseError);
  assert.equal(requests, 1_000);
});
