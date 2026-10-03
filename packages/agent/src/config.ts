import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type Config = { version: 1; shop: string | null };

export function dataDirectory(): string {
  return resolve(process.env.STOCKTRAIL_HOME || join(process.cwd(), '.stocktrail'));
}

export function normalizeShop(input: string): string {
  const shop = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error('Use a store hostname such as your-store.myshopify.com (no URL or path).');
  }
  return shop;
}

export async function initialize(directory: string, shop?: string): Promise<string> {
  const config: Config = { version: 1, shop: shop ? normalizeShop(shop) : null };
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Configuration already exists; edit config.json to change the shop. Nothing was overwritten.');
    }
    throw error;
  }
  return path;
}

export async function readConfig(directory: string): Promise<Config> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No local configuration. Run stocktrail init first.');
    }
    throw new Error('Cannot read local config.json; check its permissions and JSON syntax.');
  }
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('shop' in value) || (value.shop !== null && typeof value.shop !== 'string')) {
    throw new Error('Invalid configuration. Expected version 1 and a shop hostname or null.');
  }
  return { version: 1, shop: value.shop === null ? null : normalizeShop(value.shop) };
}
