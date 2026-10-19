export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  totalDeadlineMs: number;
};

export const DEFAULT_READ_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  maxRetryAfterMs: 5_000,
  totalDeadlineMs: 15_000,
});

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function resolveRetryPolicy(input: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy = { ...DEFAULT_READ_RETRY_POLICY, ...input };
  return {
    maxAttempts: positiveInteger(policy.maxAttempts, 'maxAttempts'),
    baseDelayMs: positiveInteger(policy.baseDelayMs, 'baseDelayMs'),
    maxDelayMs: positiveInteger(policy.maxDelayMs, 'maxDelayMs'),
    maxRetryAfterMs: positiveInteger(policy.maxRetryAfterMs, 'maxRetryAfterMs'),
    totalDeadlineMs: positiveInteger(policy.totalDeadlineMs, 'totalDeadlineMs'),
  };
}

export function parseRetryAfterMs(
  value: string | null,
  nowMs: number,
  maxRetryAfterMs: number,
): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  let delayMs: number;
  if (/^\d+$/.test(trimmed)) {
    delayMs = Number(trimmed) * 1_000;
  } else {
    const dateMs = Date.parse(trimmed);
    if (!Number.isFinite(dateMs)) return null;
    delayMs = Math.max(0, dateMs - nowMs);
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) return null;
  return Math.min(delayMs, maxRetryAfterMs);
}

export function retryDelayMs(
  policy: RetryPolicy,
  retryNumber: number,
  retryAfterMs: number | null,
  remainingMs: number,
): number | null {
  if (!Number.isSafeInteger(retryNumber) || retryNumber < 1 || retryNumber >= policy.maxAttempts) {
    return null;
  }
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** (retryNumber - 1)),
  );
  const requested = Math.max(exponential, retryAfterMs ?? 0);
  return requested < remainingMs ? requested : null;
}

export async function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, delayMs);
    timeout.unref();
    const onAbort = () => finish(signal.reason);
    function finish(error?: unknown) {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (error !== undefined) reject(error);
      else resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
