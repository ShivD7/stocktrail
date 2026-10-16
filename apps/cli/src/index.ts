#!/usr/bin/env node
import { emitKeypressEvents } from 'node:readline';
import { parseArgs } from 'node:util';
import { dataDirectory, initialize, readConfig } from '../../../packages/agent/src/config.js';
import { scanDemo } from '../../../packages/agent/src/demo.js';
import { connect, disconnect } from '../../../packages/agent/src/auth.js';
import { persistCatalogImport, previewCatalogImport } from '../../../packages/agent/src/import.js';
import { listMonitoringCandidates, updateMonitoringSelection } from '../../../packages/agent/src/monitoring.js';
import { formatImportPreview, formatPersistentImport } from './import-output.js';
import { scanAdminEvidence } from '../../../packages/agent/src/admin-scan.js';
import { formatAdminScan } from './scan-output.js';
import { scanAjaxEvidence } from '../../../packages/agent/src/ajax-scan.js';
import { formatAjaxScan } from './ajax-output.js';
import { scanEvidenceBundle } from '../../../packages/agent/src/combined-scan.js';
import { formatEvidenceBundle } from './bundle-output.js';

const help = `StockTrail — local Shopify inventory diagnostics (starter)

Usage: stocktrail <command> [options]

  init [--shop your-store.myshopify.com]  Create local configuration
  connect                               Verify and securely store a Shopify token
  login                                 Alias for connect
  logout                                Delete the stored Shopify token
  doctor                                Check local setup (offline)
  scan --demo                           Run synthetic diagnostics and save evidence
  scan --admin --product-id <gid>       Save Admin-only evidence for a monitored product
  scan --ajax --product-id <gid>        Save cookieless Ajax evidence for a monitored product
  scan --product-id <gid>               Save combined Admin, storefront, and JSON-LD evidence
  import [--limit 250]                  Import products into the local database
  import --preview [--limit 5]          Read and summarize products without saving them
  monitor list                          Show aggregate monitoring selection status
  monitor candidates                    List active local product GIDs without catalog content
  monitor add --product-id <gid>        Monitor an imported product (maximum 10)
  monitor remove --product-id <gid>     Stop monitoring an imported product

  --help, -h                            Show help
  --version, -v                         Show version

Data: .stocktrail in the current directory, or STOCKTRAIL_HOME.
Tokens are stored in the operating system credential store, never config.json.
Import preview is read-only and writes no catalog or evidence files.
Persistent import writes only to the local StockTrail database and never modifies Shopify.
Admin-only evidence is not a storefront availability verdict.
Ajax evidence is a cookieless observation from this CLI host, not a universal shopper verdict.
Combined evidence is collection-only and does not assert an availability verdict.
Full browser, cart, and checkout scans are not implemented yet. No store changes are made.`;

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
      shop: { type: 'string' }, demo: { type: 'boolean' }, admin: { type: 'boolean' }, ajax: { type: 'boolean' },
      preview: { type: 'boolean' }, limit: { type: 'string' },
      'product-id': { type: 'string' },
    },
  });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log('0.0.0'); return; }
  const [command, ...extra] = positionals;
  if (extra.length && command !== 'monitor') throw new Error('Unexpected arguments. Use --help for usage.');
  if (values.shop !== undefined && command !== 'init') throw new Error('--shop is only supported with init.');
  if (values.demo !== undefined && command !== 'scan') throw new Error('--demo is only supported with scan.');
  if (values.admin !== undefined && command !== 'scan') throw new Error('--admin is only supported with scan.');
  if (values.ajax !== undefined && command !== 'scan') throw new Error('--ajax is only supported with scan.');
  if (values.preview !== undefined && command !== 'import') throw new Error('--preview is only supported with import.');
  if (values.limit !== undefined && command !== 'import') throw new Error('--limit is only supported with import.');
  if (values['product-id'] !== undefined && command !== 'monitor' && command !== 'scan') {
    throw new Error('--product-id is only supported with monitor or scan.');
  }
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
      const scanModes = [values.demo, values.admin, values.ajax].filter(Boolean).length;
      if (scanModes > 1) throw new Error('Use exactly one of scan --demo, scan --admin, or scan --ajax.');
      if (values.demo) {
        if (values['product-id'] !== undefined) {
          throw new Error('--product-id cannot be combined with scan --demo.');
        }
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
      if (values.admin) {
        if (values['product-id'] === undefined) {
          throw new Error('--product-id is required with scan --admin.');
        }
        const result = await scanAdminEvidence(directory, values['product-id']);
        for (const line of formatAdminScan(result)) console.log(line);
        return;
      }
      if (values.ajax) {
        if (values['product-id'] === undefined) {
          throw new Error('--product-id is required with scan --ajax.');
        }
        const result = await scanAjaxEvidence(directory, values['product-id']);
        for (const line of formatAjaxScan(result)) console.log(line);
        return;
      }
      if (values['product-id'] === undefined) {
        throw new Error('--product-id is required for a combined scan, or choose scan --admin, scan --ajax, or scan --demo.');
      }
      const result = await scanEvidenceBundle(directory, values['product-id']);
      for (const line of formatEvidenceBundle(result)) console.log(line);
      return;
    }
    case 'import': {
      const rawLimit = values.limit ?? (values.preview ? '5' : '250');
      const label = values.preview ? 'Preview limit' : 'Import limit';
      if (!/^\d+$/.test(rawLimit)) throw new Error(`${label} must be a whole number from 1 to 250.`);
      const limit = Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
        throw new Error(`${label} must be a whole number from 1 to 250.`);
      }
      if (values.preview) {
        const summary = await previewCatalogImport(directory, limit);
        for (const line of formatImportPreview(summary)) console.log(line);
      } else {
        const summary = await persistCatalogImport(directory, limit);
        for (const line of formatPersistentImport(summary)) console.log(line);
      }
      return;
    }
    case 'monitor': {
      if (values.preview !== undefined || values.limit !== undefined) {
        throw new Error('Import options are not supported with monitor.');
      }
      const [action] = extra;
      if (extra.length !== 1 || !['add', 'remove', 'list', 'candidates'].includes(action ?? '')) {
        throw new Error('Use monitor list, monitor candidates, monitor add --product-id <gid>, or monitor remove --product-id <gid>.');
      }
      if ((action === 'list' || action === 'candidates') && values['product-id'] !== undefined) {
        throw new Error('--product-id is only supported with monitor add or monitor remove.');
      }
      if (action === 'candidates') {
        const candidates = await listMonitoringCandidates(directory);
        if (candidates.length === 0) console.log('No active imported products. Run stocktrail import first.');
        for (const candidate of candidates) {
          const state = candidate.present
            ? (candidate.monitored ? 'monitored' : 'available')
            : 'monitored inactive';
          console.log(`[${state}] ${candidate.productGid}`);
        }
        return;
      }
      const summary = await updateMonitoringSelection(
        directory,
        action as 'add' | 'remove' | 'list',
        values['product-id'],
      );
      console.log(`Monitored products: ${summary.monitoredProductCount}/${summary.limit}.`);
      if (summary.activeMonitoredProductCount !== summary.monitoredProductCount) {
        console.log(`Active monitored products: ${summary.activeMonitoredProductCount}.`);
      }
      return;
    }
    default: throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

main().catch((error: unknown) => {
  console.error(`StockTrail: ${error instanceof Error ? error.message : 'Unexpected error'}`);
  process.exitCode = 1;
});
