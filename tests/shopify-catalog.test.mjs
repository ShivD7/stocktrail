import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ShopifyAdminClient,
  ShopifyAuthError,
  ShopifyGraphqlError,
  ShopifyHttpError,
  ShopifyResponseError,
  ShopifyVersionMismatchError,
} from '../dist/packages/shopify/src/admin-client.js';
import { readCatalogPreview } from '../dist/packages/shopify/src/catalog.js';

const shop = 'example.myshopify.com';
const credential = 'synthetic-credential';

function variant(id, overrides = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    legacyResourceId: String(id),
    sku: `SKU-${id}`,
    selectedOptions: [{ name: 'Size', value: 'One' }],
    inventoryPolicy: 'DENY',
    inventoryQuantity: 4,
    sellableOnlineQuantity: 3,
    updatedAt: '2026-10-01T00:00:00Z',
    inventoryItem: { tracked: true },
    ...overrides,
  };
}

function product(id, variants, overrides = {}) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Synthetic product ${id}`,
    descriptionHtml: '<p>Synthetic</p>',
    seo: { title: `SEO ${id}`, description: 'Synthetic description' },
    handle: `synthetic-${id}`,
    status: 'ACTIVE',
    updatedAt: '2026-10-01T00:00:00Z',
    onlineStoreUrl: `https://example.invalid/products/synthetic-${id}`,
    variants,
    ...overrides,
  };
}

function response(data, headers = {}) {
  return Response.json({ data, extensions: { cost: { requestedQueryCost: 3 } } }, {
    headers: { 'x-shopify-api-version': '2026-10', 'x-request-id': 'synthetic-request', ...headers },
  });
}

test('paginates products synchronously and separately completes each product variants', async () => {
  const calls = [];
  const events = [];
  const pages = [
    response({ products: {
      nodes: [product('1', {
        nodes: [variant('90071992547409931234', {
          sku: null,
          inventoryQuantity: null,
          sellableOnlineQuantity: 0,
        })],
        pageInfo: { hasNextPage: true, endCursor: 'variant-cursor-1' },
      }, { seo: { title: null, description: null }, onlineStoreUrl: null })],
      pageInfo: { hasNextPage: true, endCursor: 'product-cursor-1' },
    } }),
    response({ product: { variants: {
      nodes: [variant('2', { sellableOnlineQuantity: -2 })],
      pageInfo: { hasNextPage: false, endCursor: 'variant-cursor-2' },
    } } }),
    response({ products: {
      nodes: [product('2', {
        nodes: [variant('3')],
        pageInfo: { hasNextPage: false, endCursor: 'variant-cursor-3' },
      })],
      pageInfo: { hasNextPage: false, endCursor: 'product-cursor-2' },
    } }),
  ];
  const fetcher = async (_url, options) => {
    events.push('fetch');
    const request = JSON.parse(options.body);
    assert.doesNotMatch(request.query, /\bmutation\b/i);
    calls.push(request);
    return pages.shift();
  };

  const result = await readCatalogPreview(
    new ShopifyAdminClient(shop, credential, fetcher),
    2,
    () => {
      events.push('clock');
      return new Date('2026-10-15T12:34:56.789Z');
    },
  );

  assert.equal(pages.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].variables.after, null);
  assert.equal(calls[1].variables.productId, 'gid://shopify/Product/1');
  assert.equal(calls[1].variables.after, 'variant-cursor-1');
  assert.equal(calls[2].variables.after, 'product-cursor-1');
  assert.equal(result.products.length, 2);
  assert.equal(result.complete, true);
  assert.equal(result.products[0].variants.length, 2);
  assert.equal(result.products[0].variants[0].legacyResourceId, '90071992547409931234');
  assert.equal(result.products[0].variants[0].sku, null);
  assert.equal(result.products[0].variants[0].inventoryQuantity, null);
  assert.equal(result.products[0].variants[0].sellableOnlineQuantity, 0);
  assert.equal(result.products[0].variants[1].sellableOnlineQuantity, -2);
  assert.deepEqual(result.products[0].seo, { title: null, description: null });
  assert.equal(result.products[0].publishedToOnlineStore, false);
  assert.equal(result.products[0].status, 'ACTIVE');
  assert.equal(result.products[1].publishedToOnlineStore, true);
  assert.equal(result.requestMetadata[0].requestId, 'synthetic-request');
  assert.equal(result.requestMetadata[0].apiVersion, '2026-10');
  assert.deepEqual(result.requestMetadata[0].cost, { requestedQueryCost: 3 });
  assert.deepEqual(result.provenance, {
    observedAt: '2026-10-15T12:34:56.789Z',
    evidenceSource: 'shopify_admin_graphql',
    apiVersion: '2026-10',
  });
  assert.equal(events.at(-1), 'clock');
  assert.match(calls[0].query, /sellableOnlineQuantity/);
  assert.match(calls[1].query, /sellableOnlineQuantity/);
});

test('labels a bounded read as incomplete without fetching beyond its limit', async () => {
  let requests = 0;
  const client = new ShopifyAdminClient(shop, credential, async () => {
    requests += 1;
    return response({ products: {
      nodes: [product('bounded', {
        nodes: [variant('401')],
        pageInfo: { hasNextPage: false, endCursor: null },
      })],
      pageInfo: { hasNextPage: true, endCursor: 'another-page' },
    } });
  });
  const result = await readCatalogPreview(client, 1);
  assert.equal(requests, 1);
  assert.equal(result.complete, false);
});

test('normalizes Shopify UNLISTED products without rejecting the catalog page', async () => {
  const client = new ShopifyAdminClient(shop, credential, async () => response({
    products: {
      nodes: [product('unlisted', {
        nodes: [variant('402')],
        pageInfo: { hasNextPage: false, endCursor: null },
      }, { status: 'UNLISTED' })],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  }));
  const result = await readCatalogPreview(client, 1);
  assert.equal(result.products[0].status, 'UNLISTED');
  assert.equal(result.complete, true);
});

test('rejects numeric legacy IDs instead of losing precision', async () => {
  const badProduct = product('1', {
    nodes: [variant('1', { legacyResourceId: 9007199254740992 })],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const client = new ShopifyAdminClient(shop, credential, async () => response({
    products: { nodes: [badProduct], pageInfo: { hasNextPage: false, endCursor: null } },
  }));
  await assert.rejects(() => readCatalogPreview(client, 1), /malformed catalog response/);
});

test('terminates safely when product pagination cycles across multiple cursors', async () => {
  const privateCursor = 'private-product-cursor-a';
  const pages = [
    response({ products: {
      nodes: [product('cycle-1', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } })],
      pageInfo: { hasNextPage: true, endCursor: privateCursor },
    } }),
    response({ products: {
      nodes: [product('cycle-2', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } })],
      pageInfo: { hasNextPage: true, endCursor: 'product-cursor-b' },
    } }),
    response({ products: {
      nodes: [product('cycle-3', { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } })],
      pageInfo: { hasNextPage: true, endCursor: privateCursor },
    } }),
  ];
  let requests = 0;
  const client = new ShopifyAdminClient(shop, credential, async () => {
    requests += 1;
    return pages.shift();
  });

  await assert.rejects(
    () => readCatalogPreview(client, 4),
    error => {
      assert.ok(error instanceof ShopifyResponseError);
      assert.doesNotMatch(error.message, /private-product-cursor|product-cursor-b/);
      return true;
    },
  );
  assert.equal(requests, 3);
});

test('terminates safely when variant pagination cycles across multiple cursors', async () => {
  const privateCursor = 'private-variant-cursor-a';
  const pages = [
    response({ products: {
      nodes: [product('variant-cycle', {
        nodes: [variant('101')],
        pageInfo: { hasNextPage: true, endCursor: privateCursor },
      })],
      pageInfo: { hasNextPage: false, endCursor: null },
    } }),
    response({ product: { variants: {
      nodes: [variant('102')],
      pageInfo: { hasNextPage: true, endCursor: 'variant-cursor-b' },
    } } }),
    response({ product: { variants: {
      nodes: [variant('103')],
      pageInfo: { hasNextPage: true, endCursor: privateCursor },
    } } }),
  ];
  let requests = 0;
  const client = new ShopifyAdminClient(shop, credential, async () => {
    requests += 1;
    return pages.shift();
  });

  await assert.rejects(
    () => readCatalogPreview(client, 1),
    error => {
      assert.ok(error instanceof ShopifyResponseError);
      assert.doesNotMatch(error.message, /private-variant-cursor|variant-cursor-b/);
      return true;
    },
  );
  assert.equal(requests, 3);
});

test('separates and sanitizes auth, HTTP, GraphQL, malformed, and version errors', async () => {
  const sensitive = 'private-response-detail';
  const cases = [
    [ShopifyAuthError, async () => new Response(sensitive, { status: 401 })],
    [ShopifyHttpError, async () => new Response(sensitive, { status: 500 })],
    [ShopifyGraphqlError, async () => Response.json({
      data: { private: sensitive },
      errors: [{ message: sensitive, extensions: { code: 'ACCESS_DENIED' } }],
    })],
    [ShopifyResponseError, async () => new Response('{', { status: 200 })],
    [ShopifyVersionMismatchError, async () => Response.json({ data: {} }, {
      headers: { 'x-shopify-api-version': '2025-10' },
    })],
  ];
  for (const [ErrorType, fetcher] of cases) {
    const client = new ShopifyAdminClient(shop, credential, fetcher);
    await assert.rejects(
      () => client.query('query Synthetic { shop { name } }'),
      error => {
        assert.ok(error instanceof ErrorType);
        assert.doesNotMatch(error.message, new RegExp(`${sensitive}|${credential}`));
        return true;
      },
    );
  }
});

test('treats partial GraphQL data plus errors as failure', async () => {
  const client = new ShopifyAdminClient(shop, credential, async () => Response.json({
    data: { shop: { name: 'Synthetic' } },
    errors: [{ message: 'Synthetic resolver failure' }],
  }));
  await assert.rejects(() => client.query('query Synthetic { shop { name } }'), ShopifyGraphqlError);
});

test('does not reflect an untrusted API version header in mismatch errors', async () => {
  const privateHeader = 'private-version-header-value';
  const client = new ShopifyAdminClient(shop, credential, async () => Response.json({ data: {} }, {
    headers: { 'x-shopify-api-version': privateHeader },
  }));
  await assert.rejects(
    () => client.query('query Synthetic { shop { name } }'),
    error => {
      assert.ok(error instanceof ShopifyVersionMismatchError);
      assert.equal(error.message, 'Shopify API version mismatch. StockTrail requires 2026-10.');
      assert.doesNotMatch(error.message, new RegExp(privateHeader));
      return true;
    },
  );
});

test('rejects a malformed GraphQL errors member even when data is present', async () => {
  const client = new ShopifyAdminClient(shop, credential, async () => Response.json({
    data: { shop: { name: 'Synthetic' } },
    errors: 'malformed',
  }));
  await assert.rejects(() => client.query('query Synthetic { shop { name } }'), ShopifyResponseError);
});
