import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  measureTenProductScanPerformance,
  ScanPerformanceCancelledError,
} from '../dist/packages/agent/src/performance.js';
import { formatScanPerformance } from '../dist/apps/cli/src/performance-output.js';

function candidate(index, overrides = {}) {
  return {
    productGid: `gid://shopify/Product/${index}`,
    monitored: true,
    present: true,
    ...overrides,
  };
}

test('measures exactly ten active monitored products sequentially with aggregate-only output', async () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => candidate(index + 1)),
    candidate(90, { monitored: false }),
    candidate(91, { present: false }),
  ];
  let active = 0;
  let maximumActive = 0;
  let index = 0;
  const visited = [];
  const result = await measureTenProductScanPerformance('private-directory', {
    async listCandidates() { return candidates; },
    async scan(_directory, productId, context) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      visited.push(productId);
      context.onAdminRequest();
      if (index % 2 === 0) context.onAdminRequest();
      const shouldFail = index === 2 || index === 7;
      index += 1;
      active -= 1;
      if (shouldFail) throw new Error(`private failure for ${productId}`);
      return { bundle: {}, adminRequestCount: 0 };
    },
    now: (() => { const values = [1_000, 2_750]; return () => values.shift(); })(),
  });

  assert.equal(maximumActive, 1);
  assert.equal(visited.length, 10);
  assert.deepEqual(result, { durationMs: 1_750, completed: 8, failed: 2, adminRequestCount: 15 });
  const output = formatScanPerformance(result);
  assert.deepEqual(output, [
    'Duration: 1750 ms',
    'Completed: 8',
    'Failed: 2',
    'Admin API calls: 15',
  ]);
  assert.doesNotMatch(output.join('\n'), /gid:|private|Product\//i);
});

test('requires exactly ten active monitored products before scanning', async () => {
  let scans = 0;
  await assert.rejects(() => measureTenProductScanPerformance('unused', {
    async listCandidates() { return Array.from({ length: 9 }, (_, index) => candidate(index + 1)); },
    async scan() { scans += 1; return { bundle: {}, adminRequestCount: 0 }; },
    now: () => 0,
  }), /exactly 10 active monitored products/);
  assert.equal(scans, 0);
});

test('caller cancellation stops all later products without converting it to a failed scan', async () => {
  const controller = new AbortController();
  let scans = 0;
  await assert.rejects(() => measureTenProductScanPerformance('unused', {
    async listCandidates() { return Array.from({ length: 10 }, (_, index) => candidate(index + 1)); },
    async scan(_directory, _productId, context) {
      scans += 1;
      context.onAdminRequest();
      if (scans === 2) controller.abort();
      throw new Error('private cancellation-adjacent failure');
    },
    now: () => 0,
  }, { signal: controller.signal }), ScanPerformanceCancelledError);
  assert.equal(scans, 2);
});
