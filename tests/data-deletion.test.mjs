import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteLocalData } from '../dist/packages/agent/src/data-deletion.js';

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('deletes only known local entries after exact shop confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stocktrail-delete-'));
  const config = JSON.stringify({ version: 1, shop: 'example.myshopify.com' });
  const credentialCalls = [];
  try {
    await writeFile(join(root, 'config.json'), config);
    await writeFile(join(root, 'stocktrail.sqlite'), 'synthetic database');
    await mkdir(join(root, 'artifacts', 'scans'), { recursive: true });
    await writeFile(join(root, 'artifacts', 'scans', 'private.json'), 'private synthetic evidence');
    await writeFile(join(root, 'unrelated.txt'), 'keep');
    const result = await deleteLocalData(root, 'example.myshopify.com', {
      readConfig: async () => ({ version: 1, shop: 'example.myshopify.com' }),
      deleteCredential: async shop => { credentialCalls.push(shop); return true; },
    });
    assert.deepEqual(result, { removedEntries: 3, credentialDeleted: true });
    assert.deepEqual(credentialCalls, ['example.myshopify.com']);
    assert.equal(await exists(join(root, 'config.json')), false);
    assert.equal(await exists(join(root, 'stocktrail.sqlite')), false);
    assert.equal(await exists(join(root, 'artifacts')), false);
    assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wrong confirmation and unsafe entries leave all data and credentials untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stocktrail-delete-safe-'));
  let credentialCalls = 0;
  const dependencies = {
    readConfig: async () => ({ version: 1, shop: 'example.myshopify.com' }),
    deleteCredential: async () => { credentialCalls += 1; return true; },
  };
  try {
    await writeFile(join(root, 'config.json'), 'private-config');
    await assert.rejects(deleteLocalData(root, 'wrong.myshopify.com', dependencies), /exactly match/);
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'private-config');
    await writeFile(join(root, 'artifacts'), 'unexpected file');
    await assert.rejects(deleteLocalData(root, 'example.myshopify.com', dependencies), /Unsafe local/);
    assert.equal(credentialCalls, 0);
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'private-config');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('credential failure preserves local data for a safe retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stocktrail-delete-keyring-'));
  try {
    await writeFile(join(root, 'config.json'), 'private-config');
    await assert.rejects(deleteLocalData(root, 'example.myshopify.com', {
      readConfig: async () => ({ version: 1, shop: 'example.myshopify.com' }),
      deleteCredential: async () => { throw new Error('keyring unavailable'); },
    }), /keyring unavailable/);
    assert.equal(await readFile(join(root, 'config.json'), 'utf8'), 'private-config');
  } finally { await rm(root, { recursive: true, force: true }); }
});
