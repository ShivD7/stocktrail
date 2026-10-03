import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAvailability } from '../dist/packages/detector/src/index.js';

const base = { variantId: '1', title: 'Example', tracked: true, quantity: 0, continueSelling: false, published: true, storefrontAvailable: true };
for (const [name, changes, expectedStatus] of [
  ['zero inventory contradicts available storefront', {}, 'fail'],
  ['backorders allow selling at zero', { continueSelling: true }, 'pass'],
  ['untracked inventory does not imply sold out', { tracked: false, quantity: null }, 'pass'],
  ['unknown quantity stays inconclusive', { quantity: null }, 'inconclusive'],
  ['missing storefront evidence stays inconclusive', { storefrontAvailable: null }, 'inconclusive'],
  ['unpublished product remains unavailable despite backorders', { published: false, continueSelling: true, storefrontAvailable: false }, 'pass'],
]) {
  test(name, () => assert.equal(compareAvailability({ ...base, ...changes }).status, expectedStatus));
}
