import { homedir } from 'node:os';
import { lstat, rm } from 'node:fs/promises';
import { parse, resolve } from 'node:path';
import { readConfig, type Config } from './config.js';
import { disconnect } from './auth.js';

const FILES = ['config.json', 'stocktrail.sqlite', 'stocktrail.sqlite-wal', 'stocktrail.sqlite-shm'] as const;
const DIRECTORIES = ['artifacts', 'reports'] as const;

export type LocalDataDeletion = {
  removedEntries: number;
  credentialDeleted: boolean;
};

export type DataDeletionDependencies = {
  readConfig(directory: string): Promise<Config>;
  deleteCredential(shop: string): Promise<boolean>;
};

const defaultDependencies: DataDeletionDependencies = {
  readConfig,
  deleteCredential: disconnect,
};

function assertSafeRoot(directory: string): string {
  const root = resolve(directory);
  if (root === parse(root).root || root === resolve(homedir())) {
    throw new Error('Refusing to delete StockTrail data from an unsafe directory.');
  }
  return root;
}

export async function deleteLocalData(
  directory: string,
  confirmation: string,
  dependencies: DataDeletionDependencies = defaultDependencies,
): Promise<LocalDataDeletion> {
  const root = assertSafeRoot(directory);
  const config = await dependencies.readConfig(root);
  if (!config.shop) throw new Error('No configured shop is available to confirm deletion.');
  if (confirmation !== config.shop) {
    throw new Error('Deletion confirmation must exactly match the configured shop domain.');
  }

  const entries: Array<{ path: string; kind: 'file' | 'directory' }> = [
    ...FILES.map(name => ({ path: resolve(root, name), kind: 'file' as const })),
    ...DIRECTORIES.map(name => ({ path: resolve(root, name), kind: 'directory' as const })),
  ];
  const present: typeof entries = [];
  for (const entry of entries) {
    let details;
    try { details = await lstat(entry.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Could not safely inspect local StockTrail data. Nothing was deleted.');
    }
    const valid = !details.isSymbolicLink() &&
      (entry.kind === 'file' ? details.isFile() : details.isDirectory());
    if (!valid) throw new Error('Unsafe local StockTrail data entry. Nothing was deleted.');
    present.push(entry);
  }

  // Delete the credential first. If the keyring is unavailable, preserve local
  // configuration so the user can retry instead of orphaning an unknown token.
  const credentialDeleted = await dependencies.deleteCredential(config.shop);
  for (const entry of present) {
    await rm(entry.path, { recursive: entry.kind === 'directory', force: true });
  }
  return { removedEntries: present.length, credentialDeleted };
}
