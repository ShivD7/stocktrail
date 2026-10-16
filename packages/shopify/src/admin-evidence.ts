import { z } from 'zod';
import {
  adminEvidenceReportSchema,
  assertShopifyProductGid,
  type AdminEvidenceReport,
} from '../../shared/src/admin-evidence.js';
import {
  ShopifyAdminClient,
  ShopifyResponseError,
  SHOPIFY_API_VERSION,
} from './admin-client.js';

const VARIANT_PAGE_SIZE = 100;
const MAX_PAGE_REQUESTS = 1_000;

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const variantSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  legacyResourceId: z.string().regex(/^\d+$/),
  sku: z.string().nullable().optional(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  inventoryPolicy: z.enum(['DENY', 'CONTINUE']),
  inventoryQuantity: z.number().int().nullable(),
  sellableOnlineQuantity: z.number().int(),
  updatedAt: z.string(),
  inventoryItem: z.object({
    id: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/),
    tracked: z.boolean(),
    updatedAt: z.string(),
  }),
});

const productSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
  title: z.string().optional(),
  handle: z.string().optional(),
  descriptionHtml: z.string().optional(),
  seo: z.object({ title: z.string().nullable(), description: z.string().nullable() }).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT', 'UNLISTED']),
  onlineStoreUrl: z.string().nullable(),
  updatedAt: z.string(),
  variants: z.object({
    nodes: z.array(variantSchema),
    pageInfo: pageInfoSchema,
  }),
});

const pageSchema = z.object({ product: productSchema.nullable() });
type ProductPage = z.infer<typeof productSchema>;

const adminEvidenceQuery = `#graphql
  query StockTrailAdminEvidence($productId: ID!, $first: Int!, $after: String) {
    product(id: $productId) {
      id
      title
      handle
      descriptionHtml
      seo { title description }
      status
      onlineStoreUrl
      updatedAt
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
          inventoryItem { id tracked updatedAt }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export class ShopifyProductUnavailableError extends Error {}

function malformedEvidenceResponse(): ShopifyResponseError {
  return new ShopifyResponseError('Shopify returned a malformed Admin evidence response.');
}

function consistentProduct(first: ProductPage, next: ProductPage): boolean {
  return first.id === next.id &&
    first.status === next.status &&
    first.title === next.title &&
    first.handle === next.handle &&
    first.descriptionHtml === next.descriptionHtml &&
    JSON.stringify(first.seo) === JSON.stringify(next.seo) &&
    first.onlineStoreUrl === next.onlineStoreUrl &&
    first.updatedAt === next.updatedAt;
}

export async function readAdminProductEvidence(
  client: ShopifyAdminClient,
  productId: string,
  now: () => Date = () => new Date(),
): Promise<AdminEvidenceReport> {
  assertShopifyProductGid(productId);
  const startedAt = now().toISOString();
  const variants: ProductPage['variants']['nodes'] = [];
  const seenVariantIds = new Set<string>();
  const seenCursors = new Set<string>();
  const responseVersions = new Set<string>();
  let firstProduct: ProductPage | undefined;
  let after: string | null = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_PAGE_REQUESTS) throw malformedEvidenceResponse();
    const response = await client.query<unknown>(adminEvidenceQuery, {
      productId,
      first: VARIANT_PAGE_SIZE,
      after,
    });
    pageCount += 1;
    if (response.metadata.apiVersion !== null) responseVersions.add(response.metadata.apiVersion);
    const parsed = pageSchema.safeParse(response.data);
    if (!parsed.success) throw malformedEvidenceResponse();
    const product = parsed.data.product;
    if (product === null) {
      throw new ShopifyProductUnavailableError(
        'Shopify did not return the selected product. It may be missing or inaccessible.',
      );
    }
    if (product.id !== productId) throw malformedEvidenceResponse();
    if (firstProduct === undefined) firstProduct = product;
    else if (!consistentProduct(firstProduct, product)) {
      throw new ShopifyResponseError('Shopify returned inconsistent product evidence across pages.');
    }

    for (const variant of product.variants.nodes) {
      if (seenVariantIds.has(variant.id)) throw malformedEvidenceResponse();
      seenVariantIds.add(variant.id);
      variants.push(variant);
    }

    const pageInfo = product.variants.pageInfo;
    if (!pageInfo.hasNextPage) break;
    if (pageInfo.endCursor === null || seenCursors.has(pageInfo.endCursor)) {
      throw malformedEvidenceResponse();
    }
    seenCursors.add(pageInfo.endCursor);
    after = pageInfo.endCursor;
  }

  if (firstProduct === undefined || responseVersions.size > 1) throw malformedEvidenceResponse();
  const report = adminEvidenceReportSchema.safeParse({
    schemaVersion: 1,
    mode: 'admin_only',
    source: 'shopify_admin_graphql',
    productId,
    observationWindow: { startedAt, completedAt: now().toISOString() },
    apiVersion: {
      requested: SHOPIFY_API_VERSION,
      response: responseVersions.size === 1 ? SHOPIFY_API_VERSION : null,
    },
    pageCount,
    complete: true,
    limitations: [
      'Admin API evidence only; no storefront, Ajax, HTML, or JSON-LD was observed.',
      'sellableOnlineQuantity is an Online Store baseline, not a storefront availability verdict.',
      'Shopify pagination spans an observation window and is not transactional.',
    ],
    product: {
      id: firstProduct.id,
      title: firstProduct.title,
      handle: firstProduct.handle,
      descriptionHtml: firstProduct.descriptionHtml,
      seo: firstProduct.seo,
      status: firstProduct.status,
      onlineStoreUrl: firstProduct.onlineStoreUrl,
      updatedAt: firstProduct.updatedAt,
      variants,
    },
  });
  if (!report.success) throw malformedEvidenceResponse();
  return report.data;
}
