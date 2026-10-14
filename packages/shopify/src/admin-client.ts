import { normalizeShop } from '../../shared/src/shop.js';

export const SHOPIFY_API_VERSION = '2026-10';

export type ShopifyRequestMetadata = {
  requestId: string | null;
  apiVersion: string | null;
  cost: unknown;
};

export class ShopifyAuthError extends Error {}
export class ShopifyHttpError extends Error {}
export class ShopifyGraphqlError extends Error {}
export class ShopifyResponseError extends Error {}
export class ShopifyVersionMismatchError extends Error {}

type Fetch = typeof globalThis.fetch;

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ extensions?: { code?: unknown } }>;
  extensions?: { cost?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ShopifyAdminClient {
  readonly shop: string;
  readonly #token: string;
  readonly #fetcher: Fetch;

  constructor(shopInput: string, tokenInput: string, fetcher: Fetch = globalThis.fetch) {
    this.shop = normalizeShop(shopInput);
    this.#token = tokenInput.trim();
    this.#fetcher = fetcher;
    if (!this.#token) throw new ShopifyAuthError('The Shopify Admin API token cannot be empty.');
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<{
    data: T;
    metadata: ShopifyRequestMetadata;
  }> {
    let response: Response;
    try {
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
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new ShopifyHttpError(`Shopify did not respond while reading ${this.shop}.`);
      }
      throw new ShopifyHttpError(`Could not reach Shopify for ${this.shop}. Check the shop hostname and your connection.`);
    }

    const apiVersion = response.headers.get('x-shopify-api-version');
    const metadata: ShopifyRequestMetadata = {
      requestId: response.headers.get('x-request-id'),
      apiVersion,
      cost: null,
    };

    if (apiVersion !== null && apiVersion !== SHOPIFY_API_VERSION) {
      throw new ShopifyVersionMismatchError(
        `Shopify API version mismatch. StockTrail requires ${SHOPIFY_API_VERSION}.`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ShopifyAuthError('Shopify rejected the token. Check that it is valid for this store and has not been revoked.');
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
      throw new ShopifyGraphqlError(denied
        ? 'Shopify denied access to data required by the read-only query.'
        : 'Shopify rejected the read-only Admin GraphQL query.');
    }
    if (!('data' in envelope) || envelope.data === undefined || envelope.data === null) {
      throw new ShopifyResponseError('Shopify returned an incomplete Admin API response.');
    }
    return { data: envelope.data, metadata };
  }
}
