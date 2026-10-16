import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanAdminEvidence,
  validateAdminScanTarget,
  writeAdminEvidence,
} from '../dist/packages/agent/src/admin-scan.js';
import { formatAdminScan } from '../dist/apps/cli/src/scan-output.js';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/700';
const provenance = {
  observedAt: '2026-10-15T12:00:00.000Z',
  evidenceSource: 'shopify_admin_graphql',
  apiVersion: '2026-10',
};

function report() {
  return {
    schemaVersion: 1,
    mode: 'admin_only',
    source: 'shopify_admin_graphql',
    productId,
    observationWindow: {
      startedAt: '2026-10-15T12:00:00.000Z',
      completedAt: '2026-10-15T12:00:01.000Z',
    },
    apiVersion: { requested: '2026-10', response: '2026-10' },
    pageCount: 1,
    complete: true,
    limitations: ['Admin API evidence only; not a storefront verdict.'],
    product: {
      id: productId,
      status: 'ACTIVE',
      onlineStoreUrl: 'https://example.invalid/products/synthetic',
      updatedAt: '2026-10-15T11:00:00.000Z',
      variants: [],
    },
  };
}

function importedProduct() {
  return {
    id: productId,
    title: 'Synthetic private catalog title',
    descriptionHtml: '<p>Synthetic private description</p>',
    seo: { title: null, description: null },
    handle: 'synthetic-private-handle',
    status: 'ACTIVE',
    updatedAt: '2026-10-15T10:00:00.000Z',
    onlineStoreUrl: null,
    publishedToOnlineStore: false,
    variants: [],
  };
}

test('validates locally before credentials/network, writes atomically, and formats safe output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-admin-scan-'));
  const calls = [];
  const dependencies = {
    async readConfig() { calls.push('config'); return { version: 1, shop }; },
    async validateTarget() { calls.push('validate'); },
    async readToken() { calls.push('token'); return 'synthetic-credential'; },
    async readEvidence() { calls.push('network'); return report(); },
    async writeEvidence(path, evidence) {
      calls.push('write');
      return writeAdminEvidence(path, evidence);
    },
  };
  try {
    const result = await scanAdminEvidence(directory, productId, dependencies);
    assert.deepEqual(calls, ['config', 'validate', 'token', 'network', 'write']);
    const files = await readdir(join(directory, 'reports'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^admin-[0-9a-f-]+\.json$/);
    const saved = JSON.parse(await readFile(result.path, 'utf8'));
    assert.deepEqual(saved, report());
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, 'reports'))).mode & 0o777, 0o700);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    }
    const output = formatAdminScan(result).join('\n');
    assert.match(output, /ADMIN ONLY/);
    assert.match(output, /Variants: 0/);
    assert.match(output, /Pages: 1/);
    assert.match(output, /Evidence saved locally/);
    assert.doesNotMatch(
      output,
      /gid:\/\/|2026-|ACTIVE|example\.invalid|synthetic-credential|request|query.?cost|stocktrail-admin-scan/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hardens an empty Windows file before writing, syncing, closing, and renaming', async () => {
  const calls = [];
  let contents = '';
  let opened = false;
  const storage = {
    platform: 'win32',
    async makeDirectory(path) { calls.push(['mkdir', path]); },
    async openTemporary(path) {
      calls.push(['open', path]);
      opened = true;
      assert.equal(contents, '');
      return {
        async write(value) { calls.push(['write', value.length]); contents = value; },
        async sync() { calls.push(['sync']); },
        async close() { calls.push(['close']); },
      };
    },
    async hardenWindowsAcl(path, target) {
      calls.push([`acl-${target}`, path]);
      if (target === 'directory') assert.equal(opened, false);
      assert.equal(contents, '');
    },
    async moveFile(from, to) { calls.push(['rename', from, to]); },
    async removeFile(path) { calls.push(['remove', path]); },
  };
  const path = await writeAdminEvidence('C:\\Users\\PrivateUser\\.stocktrail', report(), storage);
  assert.deepEqual(
    calls.map(call => call[0]),
    ['mkdir', 'acl-directory', 'open', 'acl-file', 'write', 'sync', 'close', 'rename'],
  );
  assert.match(calls[1][1], /reports$/);
  assert.equal(calls[3][1], calls[2][1]);
  assert.equal(calls[7][1], calls[2][1]);
  assert.equal(path, calls[7][2]);
  assert.match(contents, /"mode": "admin_only"/);
});

test('storage and ACL failures are redacted and clean both possible artifacts', async () => {
  const privatePath = 'C:\\Users\\PrivateUser\\Secret Reports';
  for (const failure of [
    'mkdir', 'directory-acl', 'open', 'file-acl', 'write', 'sync', 'close', 'rename', 'cleanup',
  ]) {
    const removals = [];
    let wroteEvidence = false;
    let opened = false;
    const storage = {
      platform: 'win32',
      async makeDirectory() {
        if (failure === 'mkdir') throw new Error(`EPERM ${privatePath}`);
      },
      async openTemporary() {
        if (failure === 'open') throw new Error(`EPERM ${privatePath}`);
        opened = true;
        return {
          async write() {
            wroteEvidence = true;
            if (failure === 'write' || failure === 'cleanup') throw new Error(`EPERM ${privatePath}`);
          },
          async sync() {
            if (failure === 'sync') throw new Error(`sync failed for ${privatePath}`);
          },
          async close() {
            if (failure === 'close') throw new Error(`close failed for ${privatePath}`);
          },
        };
      },
      async hardenWindowsAcl(_path, target) {
        if (failure === `${target}-acl`) throw new Error(`ACL failed for ${privatePath}`);
      },
      async moveFile() {
        if (failure === 'rename') throw new Error(`rename failed for ${privatePath}`);
      },
      async removeFile(path) {
        removals.push(path);
        if (failure === 'cleanup') throw new Error(`cleanup failed for ${privatePath}`);
      },
    };
    await assert.rejects(
      () => writeAdminEvidence(privatePath, report(), storage),
      error => {
        assert.equal(
          error.message,
          'Could not save the evidence report securely. No evidence was saved.',
        );
        assert.doesNotMatch(error.message, /PrivateUser|Secret Reports|[A-Z]:\\/i);
        return true;
      },
    );
    assert.equal(removals.length, 2);
    if (['mkdir', 'directory-acl', 'open', 'file-acl'].includes(failure)) {
      assert.equal(wroteEvidence, false);
    }
    if (failure === 'directory-acl') assert.equal(opened, false);
  }
});

test('rejects unmonitored and inactive products before credentials or network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-admin-target-'));
  let tokenReads = 0;
  let networkReads = 0;
  const dependencies = {
    async readConfig() { return { version: 1, shop }; },
    validateTarget: validateAdminScanTarget,
    async readToken() { tokenReads += 1; return 'synthetic-credential'; },
    async readEvidence() { networkReads += 1; return report(); },
    async writeEvidence() { throw new Error('not expected'); },
  };
  try {
    let repository = await openCatalogRepository(directory);
    repository.importCatalog(shop, [importedProduct()], true, provenance);
    repository.close();
    await assert.rejects(() => scanAdminEvidence(directory, productId, dependencies), /not monitored/);
    assert.equal(tokenReads, 0);
    assert.equal(networkReads, 0);

    repository = await openCatalogRepository(directory);
    repository.addMonitoredProduct(shop, productId);
    repository.importCatalog(shop, [], true, provenance);
    repository.close();
    await assert.rejects(() => scanAdminEvidence(directory, productId, dependencies), /inactive/);
    assert.equal(tokenReads, 0);
    assert.equal(networkReads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects absent and other-shop products before credentials or network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-admin-shop-'));
  let tokenReads = 0;
  let networkReads = 0;
  const dependencies = {
    async readConfig() { return { version: 1, shop }; },
    validateTarget: validateAdminScanTarget,
    async readToken() { tokenReads += 1; return 'synthetic-credential'; },
    async readEvidence() { networkReads += 1; return report(); },
    async writeEvidence() { throw new Error('not expected'); },
  };
  try {
    await assert.rejects(
      () => scanAdminEvidence(directory, productId, dependencies),
      /not in the configured shop local catalog/,
    );

    const repository = await openCatalogRepository(directory);
    repository.importCatalog('other.myshopify.com', [importedProduct()], true, provenance);
    repository.addMonitoredProduct('other.myshopify.com', productId);
    repository.close();
    await assert.rejects(
      () => scanAdminEvidence(directory, productId, dependencies),
      /not in the configured shop local catalog/,
    );
    assert.equal(tokenReads, 0);
    assert.equal(networkReads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not write partial evidence when collection fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-admin-failure-'));
  let writes = 0;
  const dependencies = {
    async readConfig() { return { version: 1, shop }; },
    async validateTarget() {},
    async readToken() { return 'synthetic-credential'; },
    async readEvidence() { throw new Error('Synthetic collection failure'); },
    async writeEvidence() { writes += 1; return 'not expected'; },
  };
  try {
    await assert.rejects(() => scanAdminEvidence(directory, productId, dependencies), /collection failure/);
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid product IDs before reading configuration', async () => {
  let touched = false;
  const dependencies = {
    async readConfig() { touched = true; throw new Error('not expected'); },
    async validateTarget() { touched = true; },
    async readToken() { touched = true; return ''; },
    async readEvidence() { touched = true; return report(); },
    async writeEvidence() { touched = true; return ''; },
  };
  await assert.rejects(() => scanAdminEvidence('unused', 'not-a-gid', dependencies), /Shopify Product GID/);
  assert.equal(touched, false);
});
