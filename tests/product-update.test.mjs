import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireProductWriteScope } from '../dist/packages/shopify/src/admin.js';
import {
  ShopifyMutationOutcomeUnknownError,
  ShopifyProductMutationClient,
} from '../dist/packages/shopify/src/product-update.js';

const productId = 'gid://shopify/Product/9300';
const content = {
  title: 'Safe title', descriptionHtml: '<p>Safe description.</p>',
  seo: { title: 'Safe SEO title', description: 'Safe SEO description.' },
};

test('requires the exact write_products scope for the mutation path', () => {
  assert.throws(() => requireProductWriteScope({
    shopName: 'Synthetic', shopDomain: 'example.myshopify.com', grantedScopes: ['read_products'],
  }), /write_products/);
  assert.doesNotThrow(() => requireProductWriteScope({
    shopName: 'Synthetic', shopDomain: 'example.myshopify.com', grantedScopes: ['read_products', 'write_products'],
  }));
});

test('productUpdate sends exactly one mutation with only id and approved changed fields', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      data: { productUpdate: {
        product: { id: productId, ...content, updatedAt: '2026-10-17T12:00:00.000Z' },
        userErrors: [],
      } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await new ShopifyProductMutationClient('example.myshopify.com', 'synthetic-secret', fetcher)
    .productUpdate(productId, content, ['title', 'seo.description']);
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.query, /mutation StockTrailProductUpdate/);
  assert.doesNotMatch(requests[0].body.query, /userErrors\s*\{[^}]*message/);
  assert.deepEqual(requests[0].body.variables.product, {
    id: productId, title: 'Safe title', seo: { description: 'Safe SEO description.' },
  });
  assert.doesNotMatch(JSON.stringify(requests[0].body.variables.product), /inventory|variant|handle|status|price|tag|metafield/i);
  assert.equal(result.content.descriptionHtml, content.descriptionHtml);
});

test('transport and GraphQL/user-error responses are ambiguous and expose only safe codes', async () => {
  const transport = new ShopifyProductMutationClient('example.myshopify.com', 'synthetic-secret', async () => {
    throw new Error('secret transport detail');
  });
  await assert.rejects(
    () => transport.productUpdate(productId, content, ['title']),
    error => error instanceof ShopifyMutationOutcomeUnknownError && error.safeCodes[0] === 'transport_failure',
  );
  const rejected = new ShopifyProductMutationClient('example.myshopify.com', 'synthetic-secret', async () =>
    new Response(JSON.stringify({
      data: { productUpdate: { product: null, userErrors: [{ field: ['product', 'title'], message: 'private freeform message' }] } },
    }), { status: 200 }));
  await assert.rejects(
    () => rejected.productUpdate(productId, content, ['title']),
    error => error instanceof ShopifyMutationOutcomeUnknownError && assert.deepEqual(error.safeCodes, ['field:product.title']) === undefined,
  );
});
