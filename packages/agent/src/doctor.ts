import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { readConfig, type Config } from './config.js';
import { readStoredToken } from './auth.js';
import { verifyShopifyToken, type ShopifyConnection } from '../../shopify/src/admin.js';
import { openCatalogRepository } from '../../database/src/catalog-repository.js';

export type DoctorCheck = {
  status: 'ok' | 'info';
  label: string;
  detail: string;
};

export type DoctorDependencies = {
  readConfig(directory: string): Promise<Config>;
  checkDataDirectory(directory: string): Promise<void>;
  checkDatabase(directory: string): Promise<void>;
  readToken(shop: string): Promise<string>;
  verify(shop: string, token: string): Promise<ShopifyConnection>;
};

const defaultDependencies: DoctorDependencies = {
  readConfig,
  async checkDataDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await access(directory, constants.R_OK | constants.W_OK);
  },
  async checkDatabase(directory) {
    const repository = await openCatalogRepository(directory);
    repository.close();
  },
  readToken: readStoredToken,
  verify: verifyShopifyToken,
};

function supportedNodeVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export async function diagnoseSetup(
  directory: string,
  live = false,
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<DoctorCheck[]> {
  if (!supportedNodeVersion(process.versions.node)) {
    throw new Error('Node 22.13 or newer is required.');
  }
  const config = await dependencies.readConfig(directory);
  await dependencies.checkDataDirectory(directory);
  await dependencies.checkDatabase(directory);
  const checks: DoctorCheck[] = [
    { status: 'ok', label: 'Node', detail: process.versions.node },
    { status: 'ok', label: 'Data directory', detail: 'readable and writable' },
    { status: 'ok', label: 'Database', detail: 'opened successfully' },
    config.shop
      ? { status: 'ok', label: 'Shop', detail: config.shop }
      : { status: 'info', label: 'Shop', detail: 'not configured; demo mode is available' },
  ];
  if (!live) {
    checks.push({ status: 'info', label: 'Connection', detail: 'not checked; use doctor --live' });
    return checks;
  }
  if (!config.shop) throw new Error('Configure a shop before running doctor --live.');
  const token = await dependencies.readToken(config.shop);
  const connection = await dependencies.verify(config.shop, token);
  checks.push(
    { status: 'ok', label: 'Connection', detail: 'Shopify token verified' },
    { status: 'ok', label: 'Read capability', detail: 'products' },
    connection.grantedScopes.includes('write_products')
      ? { status: 'ok', label: 'Write capability', detail: 'product writes available with explicit approval' }
      : { status: 'info', label: 'Write capability', detail: 'not granted; scans remain read-only' },
  );
  return checks;
}
