import { z } from 'zod';
import {
  catalogProvenanceSchema,
  catalogProductSchema,
  type CatalogProvenance,
  type CatalogProduct,
  type CatalogVariant,
} from '../../shared/src/catalog.js';
import {
  ShopifyAdminClient,
  ShopifyResponseError,
  SHOPIFY_API_VERSION,
  type ShopifyRequestMetadata,
} from './admin-client.js';

const PAGE_SIZE = 50;
const VARIANT_PAGE_SIZE = 100;
const MAX_PAGINATION_REQUESTS = 1_000;

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const variantSchema = z.object({
  id: z.string(),
  legacyResourceId: z.string().regex(/^\d+$/),
  sku: z.string().nullable(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  inventoryPolicy: z.enum(['DENY', 'CONTINUE']),
  inventoryQuantity: z.number().int().nullable(),
  sellableOnlineQuantity: z.number().int(),
  updatedAt: z.string(),
  inventoryItem: z.object({ tracked: z.boolean() }),
});

const variantConnectionSchema = z.object({
  nodes: z.array(variantSchema),
  pageInfo: pageInfoSchema,
});

const productSchema = z.object({
  id: z.string(),
  title: z.string(),
  descriptionHtml: z.string(),
  seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  handle: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']),
  updatedAt: z.string(),
  onlineStoreUrl: z.string().nullable(),
  variants: variantConnectionSchema,
});

const productPageSchema = z.object({
  products: z.object({
    nodes: z.array(productSchema),
    pageInfo: pageInfoSchema,
  }),
});

const variantPageSchema = z.object({
  product: z.object({ variants: variantConnectionSchema }).nullable(),
});

type ProductWire = z.infer<typeof productSchema>;

const productPageQuery = `#graphql
  query StockTrailCatalogPage($first: Int!, $after: String, $variantFirst: Int!) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        descriptionHtml
        seo { title description }
        handle
        status
        updatedAt
        onlineStoreUrl
        variants(first: $variantFirst) {
          nodes {
            id
            legacyResourceId
            sku
            selectedOptions { name value }
            inventoryPolicy
            inventoryQuantity
            sellableOnlineQuantity
            updatedAt
            inventoryItem { tracked }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const variantPageQuery = `#graphql
  query StockTrailVariantPage($productId: ID!, $first: Int!, $after: String!) {
    product(id: $productId) {
      variants(first: $first, after: $after) {
        nodes {
          id
          legacyResourceId
          sku
          selectedOptions { name value }
          inventoryPolicy
          inventoryQuantity
          sellableOnlineQuantity
          updatedAt
          inventoryItem { tracked }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export type CatalogReadResult = {
  products: CatalogProduct[];
  requestMetadata: ShopifyRequestMetadata[];
  complete: boolean;
  provenance: CatalogProvenance;
};

function malformedCatalogResponse(): Error {
  return new ShopifyResponseError('Shopify returned a malformed catalog response.');
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw malformedCatalogResponse();
  return result.data;
}

function normalizeProduct(product: ProductWire, variants: CatalogVariant[]): CatalogProduct {
  return catalogProductSchema.parse({
    id: product.id,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    seo: product.seo,
    handle: product.handle,
    status: product.status,
    updatedAt: product.updatedAt,
    onlineStoreUrl: product.onlineStoreUrl,
    publishedToOnlineStore: product.onlineStoreUrl !== null,
    variants,
  });
}

async function readAllVariants(
  client: ShopifyAdminClient,
  product: ProductWire,
  requestMetadata: ShopifyRequestMetadata[],
): Promise<CatalogVariant[]> {
  const variants: CatalogVariant[] = [...product.variants.nodes];
  const seenCursors = new Set<string>();
  let paginationRequests = 0;
  let pageInfo = product.variants.pageInfo;
  while (pageInfo.hasNextPage) {
    if (pageInfo.endCursor === null) throw malformedCatalogResponse();
    const requestedCursor = pageInfo.endCursor;
    if (seenCursors.has(requestedCursor) || paginationRequests >= MAX_PAGINATION_REQUESTS) {
      throw malformedCatalogResponse();
    }
    seenCursors.add(requestedCursor);
    paginationRequests += 1;
    const response: { data: unknown; metadata: ShopifyRequestMetadata } = await client.query<unknown>(variantPageQuery, {
      productId: product.id,
      first: VARIANT_PAGE_SIZE,
      after: requestedCursor,
    });
    requestMetadata.push(response.metadata);
    const page: z.infer<typeof variantPageSchema> = parseOrThrow(variantPageSchema, response.data);
    if (page.product === null) throw malformedCatalogResponse();
    variants.push(...page.product.variants.nodes);
    pageInfo = page.product.variants.pageInfo;
  }
  return variants;
}

export async function readCatalogPreview(
  client: ShopifyAdminClient,
  limit: number,
  now: () => Date = () => new Date(),
): Promise<CatalogReadResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new Error('Preview limit must be a whole number from 1 to 250.');
  }

  const products: CatalogProduct[] = [];
  const requestMetadata: ShopifyRequestMetadata[] = [];
  const seenCursors = new Set<string>();
  let paginationRequests = 0;
  let after: string | null = null;
  let hasNextPage = true;

  while (products.length < limit && hasNextPage) {
    if (after !== null) {
      if (seenCursors.has(after)) throw malformedCatalogResponse();
      seenCursors.add(after);
    }
    if (paginationRequests >= MAX_PAGINATION_REQUESTS) throw malformedCatalogResponse();
    paginationRequests += 1;
    const response: { data: unknown; metadata: ShopifyRequestMetadata } = await client.query<unknown>(productPageQuery, {
      first: Math.min(PAGE_SIZE, limit - products.length),
      after,
      variantFirst: VARIANT_PAGE_SIZE,
    });
    requestMetadata.push(response.metadata);
    const parsedPage: z.infer<typeof productPageSchema> = parseOrThrow(productPageSchema, response.data);
    const page: z.infer<typeof productPageSchema>['products'] = parsedPage.products;
    for (const product of page.nodes.slice(0, limit - products.length)) {
      const variants = await readAllVariants(client, product, requestMetadata);
      products.push(normalizeProduct(product, variants));
    }
    hasNextPage = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
    if (hasNextPage && after === null) throw malformedCatalogResponse();
  }

  const provenance = catalogProvenanceSchema.parse({
    observedAt: now().toISOString(),
    evidenceSource: 'shopify_admin_graphql',
    apiVersion: SHOPIFY_API_VERSION,
  });
  return { products, requestMetadata, complete: !hasNextPage, provenance };
}
