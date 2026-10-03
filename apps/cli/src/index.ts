#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { dataDirectory, initialize, readConfig } from '../../../packages/agent/src/config.js';
import { scanDemo } from '../../../packages/agent/src/demo.js';

const help = `StockTrail — local Shopify inventory diagnostics (starter)

Usage: stocktrail <command> [options]

  init [--shop your-store.myshopify.com]  Create local configuration
  doctor                                Check local setup (offline)
  scan --demo                           Run synthetic diagnostics and save evidence

  --help, -h                            Show help
  --version, -v                         Show version

Data: .stocktrail in the current directory, or STOCKTRAIL_HOME.
Live Shopify scans are not implemented yet. No store changes are made.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      shop: { type: 'string' }, demo: { type: 'boolean' },
    },
  });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log('0.0.0'); return; }
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error('Unexpected arguments. Use --help for usage.');
  if (values.shop !== undefined && command !== 'init') throw new Error('--shop is only supported with init.');
  if (values.demo !== undefined && command !== 'scan') throw new Error('--demo is only supported with scan.');
  const directory = dataDirectory();
  switch (command) {
    case undefined: console.log(help); return;
    case 'init':
      if (values.shop !== undefined && !values.shop.trim()) throw new Error('--shop cannot be empty.');
      console.log(`Created ${await initialize(directory, values.shop)}`);
      console.log('Next: stocktrail doctor or stocktrail scan --demo');
      return;
    case 'doctor': {
      const config = await readConfig(directory);
      console.log(`OK Node ${process.versions.node}`);
      console.log(`OK Configuration: ${directory}`);
      console.log(config.shop ? `OK Shop: ${config.shop}` : 'INFO Shop is not configured; demo mode is available.');
      console.log('INFO Offline setup check only. Live Shopify collection and credential storage are not implemented.');
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
    default: throw new Error(`Unknown command: ${command}. Use --help for usage.`);
  }
}

main().catch((error: unknown) => {
  console.error(`StockTrail: ${error instanceof Error ? error.message : 'Unexpected error'}`);
  process.exitCode = 1;
});
