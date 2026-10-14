import { readConfig, type Config } from './config.js';
import { readStoredToken } from './auth.js';
import { ShopifyAdminClient } from '../../shopify/src/admin-client.js';
import { readCatalogPreview, type CatalogReadResult } from '../../shopify/src/catalog.js';

export type ImportPreviewSummary = {
  status: 'preview-complete';
  productCount: number;
  variantCount: number;
  publishedProductCount: number;
};

export type ImportPreviewDependencies = {
  readConfig(directory: string): Promise<Config>;
  readToken(shop: string): Promise<string>;
  readCatalog(shop: string, token: string, limit: number): Promise<CatalogReadResult>;
};

const defaultDependencies: ImportPreviewDependencies = {
  readConfig,
  readToken: readStoredToken,
  async readCatalog(shop, token, limit) {
    return readCatalogPreview(new ShopifyAdminClient(shop, token), limit);
  },
};

export async function previewCatalogImport(
  directory: string,
  limit: number,
  dependencies: ImportPreviewDependencies = defaultDependencies,
): Promise<ImportPreviewSummary> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new Error('Preview limit must be a whole number from 1 to 250.');
  }
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  const token = await dependencies.readToken(config.shop);
  const { products } = await dependencies.readCatalog(config.shop, token, limit);
  return {
    status: 'preview-complete',
    productCount: products.length,
    variantCount: products.reduce((count, product) => count + product.variants.length, 0),
    publishedProductCount: products.filter(product => product.publishedToOnlineStore).length,
  };
}
