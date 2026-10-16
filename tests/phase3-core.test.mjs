import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  deriveExpectedPurchasable,
  evaluateST001,
  evaluateST002,
  evaluateST003,
  evaluateVariantDiagnostics,
  matchVariantReference,
} from '../dist/packages/detector/src/index.js';
import { extractHtmlEvidence, normalizeJsonLd } from '../dist/packages/shopify/src/html-evidence.js';

const fixtureRoot = resolve('fixtures/dawn-synthetic');
const runId = '11111111-1111-4111-8111-111111111111';
const evaluatedAt = '2026-10-16T12:00:02.000Z';

async function fixtureAdmin() {
  return JSON.parse(await readFile(resolve(fixtureRoot, 'admin.json'), 'utf8'));
}

test('expected purchasability uses publication, policy, tracking, and sellable quantity in order', async () => {
  const admin = await fixtureAdmin();
  const base = admin.product.variants[0];
  const cases = [
    [{ product: { status: 'DRAFT' } }, {}, 'unavailable', 'product_not_active'],
    [{ product: { onlineStoreUrl: null } }, {}, 'unavailable', 'not_published'],
    [{}, { inventoryPolicy: 'CONTINUE', sellableOnlineQuantity: 0 }, 'purchasable', 'continue_selling'],
    [{}, { inventoryItem: { ...base.inventoryItem, tracked: false }, inventoryQuantity: null }, 'purchasable', 'inventory_untracked'],
    [{}, { sellableOnlineQuantity: 2, inventoryQuantity: -50 }, 'purchasable', 'sellable_quantity_positive'],
    [{}, { sellableOnlineQuantity: 0, inventoryQuantity: 50 }, 'unavailable', 'sellable_quantity_nonpositive'],
    [{}, { sellableOnlineQuantity: -2 }, 'unavailable', 'sellable_quantity_nonpositive'],
  ];
  for (const [reportChange, variantChange, state, reasonCode] of cases) {
    const report = structuredClone(admin);
    Object.assign(report.product, reportChange.product ?? {});
    const variant = { ...base, ...variantChange };
    const derived = deriveExpectedPurchasable(report, variant);
    assert.equal(derived.state, state);
    assert.equal(derived.reasonCode, reasonCode);
  }
  assert.equal(deriveExpectedPurchasable(null, null).state, 'inconclusive');
});

test('strict matcher follows ID, unique SKU, and complete options without fuzzy fallback', async () => {
  const admin = await fixtureAdmin();
  const variants = [
    admin.product.variants[0],
    {
      ...structuredClone(admin.product.variants[0]),
      id: 'gid://shopify/ProductVariant/9002', legacyResourceId: '9002', sku: 'SYNTH-BLUE-10',
      selectedOptions: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: '10' }],
    },
  ];
  let match = matchVariantReference(variants, {
    source: 'jsonld', legacyVariantId: '9001', sku: 'SYNTH-RED-10',
    selectedOptions: [{ name: ' size ', value: '10' }, { name: 'COLOR', value: 'Red' }],
  });
  assert.equal(match.outcome, 'matched');
  assert.equal(match.method, 'variant_id');
  assert.equal(match.confidence, 'authoritative');

  match = matchVariantReference(variants, {
    source: 'jsonld', legacyVariantId: '9999', sku: 'SYNTH-RED-10', selectedOptions: null,
  });
  assert.deepEqual([match.outcome, match.reasonCode], ['inconclusive', 'unknown_variant_id']);

  match = matchVariantReference(variants, {
    source: 'jsonld', legacyVariantId: '9001', sku: 'SYNTH-BLUE-10', selectedOptions: null,
  });
  assert.deepEqual([match.outcome, match.reasonCode], ['inconclusive', 'conflicting_identifiers']);

  match = matchVariantReference([{ ...variants[0], sku: 'DUP' }, { ...variants[1], sku: 'DUP' }], {
    source: 'jsonld', legacyVariantId: null, sku: 'DUP', selectedOptions: null,
  });
  assert.deepEqual([match.outcome, match.reasonCode], ['inconclusive', 'duplicate_sku']);

  match = matchVariantReference(variants, {
    source: 'jsonld', legacyVariantId: null, sku: null,
    selectedOptions: [{ name: ' color ', value: 'Red' }, { name: 'SIZE', value: '10' }],
  });
  assert.equal(match.outcome, 'matched');
  assert.equal(match.method, 'selected_options');

  match = matchVariantReference(variants, {
    source: 'jsonld', legacyVariantId: null, sku: null,
    selectedOptions: [{ name: 'Color', value: 'red' }, { name: 'Size', value: '10' }],
  });
  assert.equal(match.outcome, 'inconclusive');
});

test('ST-001 truth table is exact and unsupported availability remains inconclusive', async () => {
  const admin = await fixtureAdmin();
  const availability = deriveExpectedPurchasable(admin, admin.product.variants[0]);
  const match = matchVariantReference(admin.product.variants, {
    source: 'jsonld', legacyVariantId: '9001', sku: null, selectedOptions: null,
  });
  const context = { availability, evidenceRunId: runId, evaluatedAt };
  for (const [canonical, result] of [
    ['InStock', 'fail'], ['OutOfStock', 'pass'], ['SoldOut', 'pass'],
    ['Discontinued', 'pass'], ['PreOrder', 'inconclusive'], [null, 'inconclusive'],
  ]) {
    const evaluation = evaluateST001(context, {
      sourceOutcome: 'observed', match, claimKind: 'Offer',
      availabilityCanonical: canonical, coherentClaimCount: 1,
    });
    assert.equal(evaluation.result, result);
  }
  assert.equal(evaluateST001(context, {
    sourceOutcome: 'inconclusive', match, claimKind: 'Offer',
    availabilityCanonical: 'InStock', coherentClaimCount: 1,
  }).result, 'inconclusive');
  assert.equal(evaluateST001(context, {
    sourceOutcome: 'observed', match, claimKind: 'Product',
    availabilityCanonical: 'InStock', coherentClaimCount: 1,
  }).result, 'inconclusive');
});

test('ST-002 and ST-003 use only exact conclusive browser observations', async () => {
  const admin = await fixtureAdmin();
  const unavailable = deriveExpectedPurchasable(admin, admin.product.variants[0]);
  const match = matchVariantReference(admin.product.variants, {
    source: 'browser', legacyVariantId: '9001', sku: null, selectedOptions: null,
  });
  const permits = JSON.parse(await readFile(resolve(fixtureRoot, 'broken/browser.json'), 'utf8'));
  const blocks = JSON.parse(await readFile(resolve(fixtureRoot, 'corrected/browser.json'), 'utf8'));
  assert.equal(evaluateST002({ availability: unavailable, evidenceRunId: runId, evaluatedAt }, permits, match).result, 'fail');
  assert.equal(evaluateST002({ availability: unavailable, evidenceRunId: runId, evaluatedAt }, blocks, match).result, 'pass');
  assert.equal(evaluateST003({ availability: unavailable, evidenceRunId: runId, evaluatedAt }, permits, match).result, 'not_applicable');

  const sellableAdmin = structuredClone(admin);
  sellableAdmin.product.variants[0].sellableOnlineQuantity = 3;
  const sellable = deriveExpectedPurchasable(sellableAdmin, sellableAdmin.product.variants[0]);
  assert.equal(evaluateST003({ availability: sellable, evidenceRunId: runId, evaluatedAt }, blocks, match).result, 'fail');
  assert.equal(evaluateST003({ availability: sellable, evidenceRunId: runId, evaluatedAt }, permits, match).result, 'pass');
  assert.equal(evaluateST002({ availability: sellable, evidenceRunId: runId, evaluatedAt }, blocks, match).result, 'not_applicable');
});

test('synthetic broken and corrected Dawn evidence evaluate the same identities for the correct reason', async () => {
  const admin = await fixtureAdmin();
  const evaluate = async state => {
    const html = await readFile(resolve(fixtureRoot, state, 'product.html'), 'utf8');
    const extracted = extractHtmlEvidence(html);
    const normalized = normalizeJsonLd(extracted.blocks, ['9001']);
    const offer = normalized.claims.find(claim => claim.kind === 'Offer');
    const browser = JSON.parse(await readFile(resolve(fixtureRoot, state, 'browser.json'), 'utf8'));
    return evaluateVariantDiagnostics({
      admin, variantId: admin.product.variants[0].id, evidenceRunId: runId, evaluatedAt,
      jsonLd: {
        sourceOutcome: normalized.reasonCode === null ? 'observed' : 'inconclusive',
        reference: offer ? { source: 'jsonld', legacyVariantId: offer.urlVariantId, sku: offer.sku, selectedOptions: null } : null,
        claimKind: offer?.kind ?? null,
        availabilityCanonical: offer?.availabilityCanonical ?? null,
        coherentClaimCount: offer ? 1 : 0,
      },
      browser,
    });
  };
  const broken = await evaluate('broken');
  assert.equal(broken.evaluations.find(value => value.ruleId === 'ST-001').result, 'fail');
  assert.equal(broken.evaluations.find(value => value.ruleId === 'ST-001').reasonCode, 'jsonld_in_stock_while_admin_unavailable');
  assert.equal(broken.evaluations.find(value => value.ruleId === 'ST-002').result, 'fail');
  const corrected = await evaluate('corrected');
  assert.equal(corrected.evaluations.find(value => value.ruleId === 'ST-001').result, 'pass');
  assert.equal(corrected.evaluations.find(value => value.ruleId === 'ST-002').result, 'pass');
});
