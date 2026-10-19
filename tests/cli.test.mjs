import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCatalogRepository } from '../dist/packages/database/src/catalog-repository.js';

const entry = resolve('dist/apps/cli/src/index.js');
test('CLI config, diagnostics, errors, and evidence work from an unrelated directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-test-'));
  const data = join(directory, 'local-data');
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, STOCKTRAIL_HOME: data },
  });
  try {
    assert.equal(run('--help').status, 0);
    assert.match(run('--help').stdout, /connect/);
    assert.match(run('--help').stdout, /dashboard/);
    assert.match(run('--help').stdout, /performance --live/);
    assert.equal(run('doctor').status, 1);
    assert.match(run('scan').stderr, /--product-id is required for a combined scan/);
    assert.match(run('scan', '--product-id', 'not-a-gid').stderr, /Shopify Product GID/);
    assert.match(
      run('scan', '--product-id', 'gid://shopify/Product/1').stderr,
      /No local configuration/,
    );
    assert.match(run('scan', '--admin').stderr, /--product-id is required/);
    assert.match(run('scan', '--admin', '--product-id', 'not-a-gid').stderr, /Shopify Product GID/);
    assert.match(
      run('scan', '--admin', '--product-id', 'gid://shopify/Product/1').stderr,
      /No local configuration/,
    );
    assert.match(run('scan', '--ajax').stderr, /--product-id is required/);
    assert.match(run('scan', '--ajax', '--product-id', 'not-a-gid').stderr, /Shopify Product GID/);
    assert.match(
      run('scan', '--ajax', '--product-id', 'gid://shopify/Product/1').stderr,
      /No local configuration/,
    );
    assert.match(run('scan', '--demo', '--admin').stderr, /exactly one of scan --demo, scan --admin, or scan --ajax/);
    assert.match(run('scan', '--admin', '--ajax').stderr, /exactly one of scan --demo, scan --admin, or scan --ajax/);
    assert.match(
      run('scan', '--demo', '--product-id', 'gid://shopify/Product/1').stderr,
      /cannot be combined with scan --demo/,
    );
    assert.match(run('doctor', '--admin').stderr, /only supported with scan/);
    assert.match(run('doctor', '--ajax').stderr, /only supported with scan/);
    assert.match(run('doctor', '--browser').stderr, /only supported with scan or test/);
    assert.match(run('scan', '--cart-add').stderr, /requires --browser/);
    assert.match(run('test', '--cart-add').stderr, /requires --browser/);
    assert.match(run('scan', '--demo', '--browser').stderr, /only supported with the combined scan/);
    assert.match(run('import').stderr, /No local configuration/);
    assert.match(run('import', '--preview', '--limit', '0').stderr, /whole number from 1 to 250/);
    assert.match(run('import', '--preview', '--limit', 'five').stderr, /whole number from 1 to 250/);
    assert.match(run('doctor', '--preview').stderr, /only supported with import/);
    assert.match(run('doctor', '--limit', '5').stderr, /only supported with import/);
    assert.match(run('scan', '--live').stderr, /only supported with doctor/);
    assert.match(run('performance').stderr, /requires --live/);
    assert.match(run('performance', '--live').stderr, /No local configuration/);
    assert.match(
      run('doctor', '--product-id', 'gid://shopify/Product/1').stderr,
      /only supported with monitor, scan, or improve/,
    );
    assert.equal(run('init', '--shop', 'https://bad.example').status, 1);
    assert.equal(run('init', '--shop', 'example.myshopify.com').status, 0);
    assert.equal(run('init', '--shop', 'replacement.myshopify.com').status, 1);
    assert.equal(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')).shop, 'example.myshopify.com');
    assert.equal(run('doctor').status, 0);
    assert.match(run('doctor').stdout, /Connection: not checked; use doctor --live/);
    assert.equal(run('monitor').status, 1);
    assert.match(run('monitor').stderr, /monitor list/);
    assert.equal(run('monitor', 'list').status, 0);
    assert.match(run('monitor', 'list').stdout, /Monitored products: 0\/10/);
    const emptyTests = run('test');
    assert.equal(emptyTests.status, 0);
    assert.match(emptyTests.stdout, /No active regression tests/);
    assert.equal(run('monitor', 'candidates').status, 0);
    assert.match(run('monitor', 'candidates').stdout, /No active imported products/);
    assert.match(run('monitor', 'add').stderr, /--product-id is required/);
    const nonInteractiveConnect = run('connect');
    assert.equal(nonInteractiveConnect.status, 1);
    assert.match(nonInteractiveConnect.stderr, /interactive terminal/);
    assert.equal(run('scan').status, 1);
    assert.equal(run('scan', '--demo').status, 2);
    const [file] = await readdir(join(data, 'reports'));
    const report = JSON.parse(await readFile(join(data, 'reports', file), 'utf8'));
    assert.equal(report.mode, 'demo');
    assert.deepEqual(report.findings.map(finding => finding.status), ['fail', 'pass']);
    assert.equal(run('scan', '--demo', '--shop', 'example.myshopify.com').status, 1);
    assert.equal(run('deploy').status, 1);
    assert.equal(run('--unknown').status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('monitor candidates exposes removable inactive GIDs without catalog content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stocktrail-monitor-cli-'));
  const data = join(directory, 'local-data');
  const run = (...args) => spawnSync(process.execPath, [entry, ...args], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, STOCKTRAIL_HOME: data },
  });
  const syntheticProduct = {
    id: 'gid://shopify/Product/901',
    title: 'Synthetic title that must stay out of CLI output',
    descriptionHtml: '<p>Synthetic description</p>',
    seo: { title: null, description: null },
    handle: 'synthetic-private-handle',
    status: 'UNLISTED',
    updatedAt: '2026-10-01T00:00:00Z',
    onlineStoreUrl: null,
    publishedToOnlineStore: false,
    variants: [],
  };
  const provenance = {
    observedAt: '2026-10-15T12:00:00.000Z',
    evidenceSource: 'shopify_admin_graphql',
    apiVersion: '2026-10',
  };
  try {
    assert.equal(run('init', '--shop', 'example.myshopify.com').status, 0);
    let repository = await openCatalogRepository(data);
    repository.importCatalog('example.myshopify.com', [syntheticProduct], true, provenance);
    repository.addMonitoredProduct('example.myshopify.com', syntheticProduct.id);
    repository.importCatalog('example.myshopify.com', [], true, provenance);
    repository.close();

    const candidates = run('monitor', 'candidates');
    assert.equal(candidates.status, 0);
    assert.match(candidates.stdout, /\[monitored inactive\] gid:\/\/shopify\/Product\/901/);
    assert.doesNotMatch(candidates.stdout, /Synthetic title|synthetic-private-handle/);
    assert.equal(run('monitor', 'remove', '--product-id', syntheticProduct.id).status, 0);

    repository = await openCatalogRepository(data);
    assert.equal(repository.monitoringSummary('example.myshopify.com').monitoredProductCount, 0);
    repository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
