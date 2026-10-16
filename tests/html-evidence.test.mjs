import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHtmlEvidence, normalizeJsonLd } from '../dist/packages/shopify/src/html-evidence.js';

test('tokenizes canonical and inline JSON-LD without executing, decoding, or following content', () => {
  const html = `<html><head>
    <link REL="alternate canonical" href="/products/item?x=1&amp;y=2">
    <script src="/remote.json" type="application/ld+json">{"@type":"Product"}</script>
    <script TYPE="Application/LD+JSON; charset=UTF-8">[
      {"@type":"ProductGroup","@id":"#group","productGroupID":"group-1","hasVariant":{"@id":"#variant"}},
      {"@type":"Product","@id":"#variant","isVariantOf":{"@id":"#group"},"offers":{"@type":"AggregateOffer","@id":"#aggregate","offers":[{"@type":"Offer","@id":"#offer","url":"/products/item?variant=9007199254740993","sku":"private-sku","price":"12.50","priceCurrency":"CAD","availability":"https://schema.org/InStock","itemOffered":{"@id":"#variant"}}]}}
    ]</script></head></html>`;
  const extracted = extractHtmlEvidence(html);
  assert.equal(extracted.reasonCode, null);
  assert.equal(extracted.canonicalHref, '/products/item?x=1&amp;y=2');
  assert.equal(extracted.blocks.length, 1);
  const normalized = normalizeJsonLd(extracted.blocks, ['9007199254740993']);
  assert.equal(normalized.reasonCode, null);
  assert.deepEqual(normalized.claims.map(claim => claim.kind), ['ProductGroup', 'Product', 'AggregateOffer', 'Offer']);
  const offer = normalized.claims.at(-1);
  assert.equal(offer.matchedLegacyVariantId, '9007199254740993');
  assert.equal(offer.availabilityCanonical, 'InStock');
  assert.equal(offer.parent, '#variant');
});

test('parses blocks independently and keeps valid claims beside malformed data', () => {
  const result = normalizeJsonLd([
    '{"@type":"Product","@id":"#valid"}',
    '{',
  ], []);
  assert.equal(result.reasonCode, 'malformed_jsonld');
  assert.equal(result.validBlockCount, 1);
  assert.equal(result.claims.length, 1);
  assert.deepEqual(result.blocks.map(block => block.status), ['valid', 'malformed']);
});

test('resolves same-document @id relationships without fetching them', () => {
  const result = normalizeJsonLd([JSON.stringify({
    '@graph': [
      { '@type': 'Product', '@id': '#product', offers: { '@id': '#offer' } },
      { '@type': 'Offer', '@id': '#offer', url: '?variant=44' },
    ],
  })], ['44']);
  const offer = result.claims.find(claim => claim.kind === 'Offer');
  assert.equal(offer.parent, '#product');
  assert.equal(offer.matchedLegacyVariantId, '44');
});

test('enforces script and JSON traversal budgets', () => {
  const scripts = Array.from({ length: 65 }, () => '<script type="application/ld+json">{}</script>').join('');
  const extracted = extractHtmlEvidence(`<html><head>${scripts}</head></html>`);
  assert.equal(extracted.reasonCode, 'html_budget_exceeded');
  assert.equal(extracted.blocks.length, 64);

  let nested = '{"@type":"Product"}';
  for (let index = 0; index < 70; index += 1) nested = `{"child":${nested}}`;
  const normalized = normalizeJsonLd([nested], []);
  assert.equal(normalized.reasonCode, 'jsonld_budget_exceeded');
  assert.equal(normalized.blocks[0].status, 'budget_exceeded');
});
