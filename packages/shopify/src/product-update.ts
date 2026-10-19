import { z } from 'zod';
import { normalizeShop } from '../../shared/src/shop.js';
import { productContentSchema, type ProductContent, type ProposalField } from '../../shared/src/proposals.js';
import { createDeadlineSignal } from '../../shared/src/resilience.js';
import { SHOPIFY_API_VERSION } from './admin-client.js';

type Fetch = typeof globalThis.fetch;

export class ShopifyMutationOutcomeUnknownError extends Error {
  constructor(readonly safeCodes: string[]) { super('Shopify write outcome requires reconciliation.'); }
}

const responseSchema = z.object({
  data: z.object({
    productUpdate: z.object({
      product: z.object({
        id: z.string(), title: z.string(), descriptionHtml: z.string(),
        seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
        updatedAt: z.string(),
      }).nullable(),
      userErrors: z.array(z.object({
        code: z.string().nullable().optional(),
        field: z.array(z.string()).nullable().optional(),
      }).passthrough()),
    }),
  }).optional(),
  errors: z.array(z.object({ extensions: z.object({ code: z.string().optional() }).optional() }).passthrough()).optional(),
}).passthrough();

const mutation = `#graphql
  mutation StockTrailProductUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title descriptionHtml seo { title description } updatedAt }
      userErrors { field }
    }
  }
`;

export type ProductUpdateResult = {
  productId: string;
  updatedAt: string;
  content: ProductContent;
  errorCodes: string[];
};

export class ShopifyProductMutationClient {
  readonly #shop: string;
  readonly #token: string;
  readonly #fetcher: Fetch;

  constructor(shop: string, token: string, fetcher: Fetch = globalThis.fetch) {
    this.#shop = normalizeShop(shop);
    this.#token = token.trim();
    this.#fetcher = fetcher;
    if (!this.#token) throw new Error('The Shopify Admin API token cannot be empty.');
  }

  async productUpdate(productId: string, candidate: ProductContent, fields: ProposalField[]): Promise<ProductUpdateResult> {
    const input: Record<string, unknown> = { id: productId };
    if (fields.includes('title')) input.title = candidate.title;
    if (fields.includes('descriptionHtml')) input.descriptionHtml = candidate.descriptionHtml;
    const seo: Record<string, string | null> = {};
    if (fields.includes('seo.title')) seo.title = candidate.seo.title;
    if (fields.includes('seo.description')) seo.description = candidate.seo.description;
    if (Object.keys(seo).length > 0) input.seo = seo;
    if (Object.keys(input).length === 1) throw new Error('Product update contains no approved field changes.');

    let response: Response;
    const deadline = createDeadlineSignal(15_000);
    try {
      response = await this.#fetcher(`https://${this.#shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.#token },
        body: JSON.stringify({ query: mutation, variables: { product: input } }),
        redirect: 'error',
        signal: deadline.signal,
      });
    } catch {
      throw new ShopifyMutationOutcomeUnknownError(['transport_failure']);
    } finally {
      deadline.dispose();
    }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new ShopifyMutationOutcomeUnknownError(['unreadable_response']); }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new ShopifyMutationOutcomeUnknownError(['malformed_response']);
    const topCodes = parsed.data.errors?.map(error => error.extensions?.code ?? 'graphql_error') ?? [];
    const payload = parsed.data.data?.productUpdate;
    const userCodes = payload?.userErrors.map(error => error.code ?? `field:${(error.field ?? []).join('.') || 'unknown'}`) ?? [];
    const safeCodes = [...topCodes, ...userCodes].filter((value, index, all) => all.indexOf(value) === index);
    if (!response.ok || safeCodes.length > 0 || payload?.product === null || payload === undefined) {
      throw new ShopifyMutationOutcomeUnknownError(safeCodes.length ? safeCodes : [`http_${response.status}`]);
    }
    const content = productContentSchema.parse({
      title: payload.product.title,
      descriptionHtml: payload.product.descriptionHtml,
      seo: payload.product.seo,
    });
    return { productId: payload.product.id, updatedAt: payload.product.updatedAt, content, errorCodes: [] };
  }
}
