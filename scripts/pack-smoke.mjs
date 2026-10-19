import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const npmCli = process.env.npm_execpath;
const temporary = await mkdtemp(join(tmpdir(), 'stocktrail-pack-'));
const installRoot = join(temporary, 'consumer');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 90_000, ...options });
  if (result.error) throw result.error;
  return result;
}

function runNpm(args, options = {}) {
  if (!npmCli) throw new Error('npm executable path is unavailable. Run this check through npm run test:pack.');
  return run(process.execPath, [npmCli, ...args], options);
}

try {
  const packed = runNpm(['pack', '--json', '--pack-destination', temporary], { cwd: resolve('.') });
  if (packed.status !== 0) throw new Error('npm pack failed.');
  const json = packed.stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (!json) throw new Error('npm pack did not return readable package metadata.');
  const packResult = JSON.parse(json);
  if (!Array.isArray(packResult) || typeof packResult[0]?.filename !== 'string') {
    throw new Error('npm pack did not report a package filename.');
  }
  const tarball = join(temporary, packResult[0].filename);
  await mkdir(installRoot);
  const installed = runNpm([
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--prefer-offline', tarball,
  ], { cwd: installRoot });
  if (installed.status !== 0) throw new Error('Packed CLI installation failed.');

  const manifest = JSON.parse(await readFile(join(installRoot, 'node_modules', 'stocktrail', 'package.json'), 'utf8'));
  const entry = join(installRoot, 'node_modules', 'stocktrail', manifest.bin.stocktrail);
  const help = run(process.execPath, [entry, '--help'], { cwd: installRoot });
  if (help.status !== 0 || !/StockTrail/.test(help.stdout) || !/delete-data/.test(help.stdout)) {
    throw new Error('Packed CLI help smoke test failed.');
  }
  const demo = run(process.execPath, [entry, 'scan', '--demo'], {
    cwd: installRoot,
    env: { ...process.env, STOCKTRAIL_HOME: join(temporary, 'data') },
  });
  if (demo.status !== 2 || !/synthetic fixtures/.test(demo.stdout)) {
    throw new Error('Packed CLI offline demo smoke test failed.');
  }
  console.log('Packed CLI install, help, and offline demo checks passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
