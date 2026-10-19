import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_READ_RETRY_POLICY,
  parseRetryAfterMs,
  resolveRetryPolicy,
  retryDelayMs,
} from '../dist/packages/shared/src/resilience.js';

test('read retry policy resolves deterministic bounded defaults and overrides', () => {
  assert.deepEqual(resolveRetryPolicy(), DEFAULT_READ_RETRY_POLICY);
  assert.deepEqual(resolveRetryPolicy({ maxAttempts: 4, baseDelayMs: 100 }), {
    ...DEFAULT_READ_RETRY_POLICY,
    maxAttempts: 4,
    baseDelayMs: 100,
  });
  assert.throws(() => resolveRetryPolicy({ maxAttempts: 0 }), /positive integer/);
});

test('retry delays are exponential, capped, and stop before exhausting the deadline', () => {
  const policy = resolveRetryPolicy({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250 });
  assert.equal(retryDelayMs(policy, 1, null, 1_000), 100);
  assert.equal(retryDelayMs(policy, 2, null, 1_000), 200);
  assert.equal(retryDelayMs(policy, 3, null, 1_000), 250);
  assert.equal(retryDelayMs(policy, 4, null, 250), null);
  assert.equal(retryDelayMs(policy, 5, null, 1_000), null);
});

test('Retry-After accepts delay seconds or dates without exceeding its safety cap', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  assert.equal(parseRetryAfterMs('2', now, 5_000), 2_000);
  assert.equal(parseRetryAfterMs('20', now, 5_000), 5_000);
  assert.equal(parseRetryAfterMs('Sun, 18 Oct 2026 12:00:03 GMT', now, 5_000), 3_000);
  assert.equal(parseRetryAfterMs('private invalid value', now, 5_000), null);
  assert.equal(parseRetryAfterMs(null, now, 5_000), null);
});
