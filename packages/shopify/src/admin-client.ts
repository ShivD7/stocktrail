import { normalizeShop } from '../../shared/src/shop.js';
import {
  parseRetryAfterMs,
  resolveRetryPolicy,
  retryDelayMs,
  sleepWithSignal,
  type RetryPolicy,
} from '../../shared/src/resilience.js';

export const SHOPIFY_API_VERSION = '2026-10';

export type ShopifyRequestMetadata = {
  requestId: string | null;
  apiVersion: string | null;
  cost: unknown;
  requestCount: number;
};

export class ShopifyAuthError extends Error {}
export class ShopifyHttpError extends Error {}
export class ShopifyRequestCancelledError extends ShopifyHttpError {}
export class ShopifyRequestTimeoutError extends ShopifyHttpError {}
export class ShopifyGraphqlError extends Error {}
export class ShopifyResponseError extends Error {}
export class ShopifyVersionMismatchError extends Error {}

type Fetch = typeof globalThis.fetch;

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ extensions?: { code?: unknown } }>;
  extensions?: { cost?: unknown };
};

export type ShopifyAdminClientOptions = {
  retryPolicy?: Partial<RetryPolicy>;
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onRequest?: () => void;
};

export type ShopifyQueryOptions = {
  signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ShopifyAdminClient {
  readonly shop: string;
  readonly #token: string;
  readonly #fetcher: Fetch;
  readonly #retryPolicy: RetryPolicy;
  readonly #now: () => number;
  readonly #sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #onRequest: () => void;

  constructor(
    shopInput: string,
    tokenInput: string,
    fetcher: Fetch = globalThis.fetch,
    options: ShopifyAdminClientOptions = {},
  ) {
    this.shop = normalizeShop(shopInput);
    this.#token = tokenInput.trim();
    this.#fetcher = fetcher;
    this.#retryPolicy = resolveRetryPolicy(options.retryPolicy);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepWithSignal;
    this.#onRequest = options.onRequest ?? (() => undefined);
    if (!this.#token) throw new ShopifyAuthError('The Shopify Admin API token cannot be empty.');
  }

  async query<T>(
    query: string,
    variables: Record<string, unknown> = {},
    options: ShopifyQueryOptions = {},
  ): Promise<{
    data: T;
    metadata: ShopifyRequestMetadata;
  }> {
    const startedAt = this.#now();
    const deadlineAt = startedAt + this.#retryPolicy.totalDeadlineMs;
    const readOnly = !/\bmutation\b/i.test(query);
    const maxAttempts = readOnly ? this.#retryPolicy.maxAttempts : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.#throwIfCancelled(options.signal);
      const remainingMs = deadlineAt - this.#now();
      if (remainingMs <= 0) throw this.#timeoutError();
      const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
      const signal = options.signal
        ? AbortSignal.any([options.signal, deadlineSignal])
        : deadlineSignal;

      let response: Response;
      try {
        this.#onRequest();
        response = await this.#fetcher(
          `https://${this.shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Access-Token': this.#token,
            },
            body: JSON.stringify({ query, variables }),
            redirect: 'error',
            signal,
          },
        );
      } catch (error) {
        this.#throwIfCancelled(options.signal);
        if (deadlineSignal.aborted || this.#now() >= deadlineAt ||
            (error instanceof Error && error.name === 'TimeoutError')) {
          throw this.#timeoutError();
        }
        if (attempt < maxAttempts) {
          await this.#waitForRetry(attempt, null, deadlineAt, options.signal);
          continue;
        }
        throw new ShopifyHttpError(`Could not reach Shopify for ${this.shop}. Check the shop hostname and your connection.`);
      }

      const apiVersion = response.headers.get('x-shopify-api-version');
      const metadata: ShopifyRequestMetadata = {
        requestId: response.headers.get('x-request-id'),
        apiVersion,
        cost: null,
        requestCount: attempt,
      };

      if (apiVersion !== null && apiVersion !== SHOPIFY_API_VERSION) {
        throw new ShopifyVersionMismatchError(
          `Shopify API version mismatch. StockTrail requires ${SHOPIFY_API_VERSION}.`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new ShopifyAuthError('Shopify rejected the token. Check that it is valid for this store and has not been revoked.');
      }
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get('retry-after'),
          this.#now(),
          this.#retryPolicy.maxRetryAfterMs,
        );
        await response.body?.cancel().catch(() => undefined);
        await this.#waitForRetry(attempt, retryAfterMs, deadlineAt, options.signal);
        continue;
      }
      if (!response.ok) {
        throw new ShopifyHttpError(`Shopify Admin API request failed with HTTP ${response.status}.`);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new ShopifyResponseError('Shopify returned an unreadable Admin API response.');
      }
      if (!isRecord(raw)) {
        throw new ShopifyResponseError('Shopify returned a malformed Admin API response.');
      }

      const envelope = raw as GraphqlEnvelope<T>;
      metadata.cost = isRecord(envelope.extensions) ? envelope.extensions.cost ?? null : null;
      if ('errors' in envelope && envelope.errors !== undefined && !Array.isArray(envelope.errors)) {
        throw new ShopifyResponseError('Shopify returned a malformed Admin API response.');
      }
      if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
        const denied = envelope.errors.some(error => error?.extensions?.code === 'ACCESS_DENIED');
        const throttled = envelope.errors.some(error => error?.extensions?.code === 'THROTTLED');
        if (!denied && throttled && attempt < maxAttempts) {
          await this.#waitForRetry(attempt, null, deadlineAt, options.signal);
          continue;
        }
        throw new ShopifyGraphqlError(denied
          ? 'Shopify denied access to data required by the read-only query.'
          : 'Shopify rejected the read-only Admin GraphQL query.');
      }
      if (!('data' in envelope) || envelope.data === undefined || envelope.data === null) {
        throw new ShopifyResponseError('Shopify returned an incomplete Admin API response.');
      }
      return { data: envelope.data, metadata };
    }
    throw new ShopifyHttpError('Shopify Admin API read failed.');
  }

  #throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new ShopifyRequestCancelledError('Shopify Admin API read was cancelled.');
  }

  #timeoutError(): ShopifyRequestTimeoutError {
    return new ShopifyRequestTimeoutError(`Shopify did not respond while reading ${this.shop}.`);
  }

  async #waitForRetry(
    retryNumber: number,
    retryAfterMs: number | null,
    deadlineAt: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<void> {
    this.#throwIfCancelled(callerSignal);
    const remainingMs = deadlineAt - this.#now();
    const delayMs = retryDelayMs(this.#retryPolicy, retryNumber, retryAfterMs, remainingMs);
    if (delayMs === null) throw this.#timeoutError();
    const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineSignal])
      : deadlineSignal;
    try {
      await this.#sleep(delayMs, signal);
    } catch {
      this.#throwIfCancelled(callerSignal);
      throw this.#timeoutError();
    }
  }
}
