import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
    assert.equal(run('doctor').status, 1);
    assert.equal(run('init', '--shop', 'https://bad.example').status, 1);
    assert.equal(run('init', '--shop', 'example.myshopify.com').status, 0);
    assert.equal(run('init', '--shop', 'replacement.myshopify.com').status, 1);
    assert.equal(JSON.parse(await readFile(join(data, 'config.json'), 'utf8')).shop, 'example.myshopify.com');
    assert.equal(run('doctor').status, 0);
    assert.match(run('doctor').stdout, /stocktrail connect/);
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
