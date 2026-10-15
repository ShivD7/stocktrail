import { readConfig, type Config } from './config.js';
import { readStoredToken } from './auth.js';
import { ShopifyAdminClient } from '../../shopify/src/admin-client.js';
import { readCatalogPreview, type CatalogReadResult } from '../../shopify/src/catalog.js';
import {
  openCatalogRepository,
  type CatalogImportResult,
  type CatalogRepository,
} from '../../database/src/catalog-repository.js';

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

export type PersistentImportSummary = CatalogImportResult & {
  status: 'import-complete';
  publishedProductCount: number;
  fullSnapshot: boolean;
};

export type PersistentImportDependencies = ImportPreviewDependencies & {
  openRepository(directory: string): Promise<CatalogRepository>;
};

const defaultDependencies: ImportPreviewDependencies = {
  readConfig,
  readToken: readStoredToken,
  async readCatalog(shop, token, limit) {
    return readCatalogPreview(new ShopifyAdminClient(shop, token), limit);
  },
};

const defaultPersistentDependencies: PersistentImportDependencies = {
  ...defaultDependencies,
  openRepository: openCatalogRepository,
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

export async function persistCatalogImport(
  directory: string,
  limit: number,
  dependencies: PersistentImportDependencies = defaultPersistentDependencies,
): Promise<PersistentImportSummary> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new Error('Import limit must be a whole number from 1 to 250.');
  }
  const config = await dependencies.readConfig(directory);
  if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
  const token = await dependencies.readToken(config.shop);
  const catalog = await dependencies.readCatalog(config.shop, token, limit);
  const repository = await dependencies.openRepository(directory);
  try {
    const result = repository.importCatalog(
      config.shop,
      catalog.products,
      catalog.complete,
      catalog.provenance,
    );
    return {
      status: 'import-complete',
      ...result,
      publishedProductCount: catalog.products.filter(product => product.publishedToOnlineStore).length,
      fullSnapshot: catalog.complete,
    };
  } finally {
    repository.close();
  }
}
