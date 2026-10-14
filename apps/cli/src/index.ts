#!/usr/bin/env node
import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { dataDirectory, initialize, readConfig } from '../../../packages/agent/src/config.js';
import { scanDemo } from '../../../packages/agent/src/demo.js';
import { connect, disconnect } from '../../../packages/agent/src/auth.js';
import { previewCatalogImport } from '../../../packages/agent/src/import.js';
import { formatImportPreview } from './import-output.js';

const help = `StockTrail — local Shopify inventory diagnostics (starter)

Usage: stocktrail <command> [options]

  init [--shop your-store.myshopify.com]  Create local configuration
  connect                               Verify and securely store a Shopify token
  login                                 Alias for connect
  logout                                Delete the stored Shopify token
  doctor                                Check local setup (offline)
  scan --demo                           Run synthetic diagnostics and save evidence
  import --preview [--limit 5]          Read and summarize products without saving them

  --help, -h                            Show help
  --version, -v                         Show version

Data: .stocktrail in the current directory, or STOCKTRAIL_HOME.
Tokens are stored in the operating system credential store, never config.json.
Import preview is read-only and writes no catalog or evidence files.
Live Shopify scans are not implemented yet. No store changes are made.`;

async function promptForToken(): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run stocktrail connect in an interactive terminal so the token can be entered securely.');
  }

  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  output.write('Shopify Admin API token: ');
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let token = '';
    const finish = (error?: Error) => {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(token);
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Login cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        token = token.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && text) token += text;
    };
    input.on('keypress', onKeypress);
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      shop: { type: 'string' }, demo: { type: 'boolean' },
      preview: { type: 'boolean' }, limit: { type: 'string' },
    },
  });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log('0.0.0'); return; }
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error('Unexpected arguments. Use --help for usage.');
  if (values.shop !== undefined && command !== 'init') throw new Error('--shop is only supported with init.');
  if (values.demo !== undefined && command !== 'scan') throw new Error('--demo is only supported with scan.');
  if (values.preview !== undefined && command !== 'import') throw new Error('--preview is only supported with import.');
  if (values.limit !== undefined && command !== 'import') throw new Error('--limit is only supported with import.');
  const directory = dataDirectory();
  switch (command) {
    case undefined: console.log(help); return;
    case 'init':
      if (values.shop !== undefined && !values.shop.trim()) throw new Error('--shop cannot be empty.');
      console.log(`Created ${await initialize(directory, values.shop)}`);
      console.log(values.shop
        ? 'Next: stocktrail connect'
        : 'Next: stocktrail doctor or stocktrail scan --demo');
      return;
    case 'connect':
    case 'login': {
      const config = await readConfig(directory);
      if (!config.shop) throw new Error('No shop is configured. Run stocktrail init --shop your-store.myshopify.com first.');
      const token = await promptForToken();
      console.log(`Verifying ${config.shop} with Shopify...`);
      const connection = await connect(config.shop, token);
      console.log(`Connected to ${connection.shopName} (${connection.shopDomain}).`);
      console.log('Token saved in the operating system credential store.');
      return;
    }
    case 'logout': {
      const config = await readConfig(directory);
      if (!config.shop) throw new Error('No shop is configured.');
      const deleted = await disconnect(config.shop);
      console.log(deleted
        ? `Logged out of ${config.shop}; the stored token was deleted.`
        : `No stored token was found for ${config.shop}.`);
      return;
    }
    case 'doctor': {
      const config = await readConfig(directory);
      console.log(`OK Node ${process.versions.node}`);
      console.log(`OK Configuration: ${directory}`);
      console.log(config.shop ? `OK Shop: ${config.shop}` : 'INFO Shop is not configured; demo mode is available.');
      console.log('INFO Offline setup check only. Use stocktrail connect to verify and store a Shopify token.');
      return;
    }
    case 'scan': {
      if (!values.demo) throw new Error('Live Shopify scans are not implemented yet. Use scan --demo for synthetic diagnostics.');
      const { report, path } = await scanDemo(directory);
      console.log('DEMO — synthetic fixtures; no store was contacted.');
      for (const finding of report.findings) {
        console.log(`${finding.status.toUpperCase()} ${finding.title} (expected=${finding.expected}, storefront=${finding.observed})`);
      }
      console.log(`Evidence saved: ${path}`);
      // 2 means completed diagnostics found a contradiction; 1 means a command error.
      if (report.findings.some(finding => finding.status === 'fail')) process.exitCode = 2;
      return;
    }
    case 'import': {
      if (!values.preview) throw new Error('Import requires --preview; persistent catalog import is not implemented.');
      const rawLimit = values.limit ?? '5';
      if (!/^\d+$/.test(rawLimit)) throw new Error('Preview limit must be a whole number from 1 to 250.');
      const limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
        throw new Error('Preview limit must be a whole number from 1 to 250.');
      }
      const summary = await previewCatalogImport(directory, limit);
      for (const line of formatImportPreview(summary)) console.log(line);
      return;
    }
    default: throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

main().catch((error: unknown) => {
  console.error(`StockTrail: ${error instanceof Error ? error.message : 'Unexpected error'}`);
  process.exitCode = 1;
});
