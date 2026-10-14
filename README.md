# StockTrail

A local diagnostic CLI for comparing Shopify inventory with what shoppers and search engines see. This repository is now a CLI starter. It does not run an embedded Shopify app or require a web server, tunnel, or deployment.

## Quick start (PowerShell)

Use Node.js 24 (or Node.js 22.12+) and npm.

```powershell
npm install
npm run dev -- --help
npm run dev -- init --shop your-store.myshopify.com
npm run dev -- connect
npm run dev -- doctor
npm run dev -- scan --demo
```

The demo uses two synthetic products, prints one FAIL and one PASS, and saves a JSON evidence report under `.stocktrail/reports`. It makes no network requests. A diagnostic contradiction exits with code **2**; command/configuration errors exit with **1**; success exits with **0**.

Configuration is created once in `.stocktrail/config.json` under the current directory. Repeating `init` never overwrites it. Omit `--shop` to try the offline demo. Set `$env:STOCKTRAIL_HOME` to an absolute directory if you want one data location across working directories. Configuration and evidence are ignored by Git. Do not put tokens in config.json.

`connect` (also available as `login`) prompts for a Shopify Admin API token without displaying it, verifies the store identity and the `read_products` and `read_inventory` scopes against Shopify Admin GraphQL API version `2026-10`, and only then saves the token. StockTrail uses Windows Credential Manager, macOS Keychain, or a Linux Secret Service provider. On Linux, the desktop keyring must be installed, running, and unlocked. The token is keyed by the configured `*.myshopify.com` hostname and is never written to `config.json` or diagnostic output.

Run `npm run dev -- logout` to delete the configured store's token from the OS credential store. A failed verification leaves any existing saved credential unchanged. Live inventory collection is still a later step; this connection is now ready for the Shopify adapter to retrieve with `readStoredToken`.

To use the command directly while developing:

```powershell
npm run build
npm link
stocktrail --help
stocktrail scan --demo
```

After editing TypeScript, rebuild or use `npm run dev -- <command>`. `npm start -- <command>` runs the last build. This package is private and has not been published; use the local scripts or link instead of fetching `npx stocktrail` from npm.

## Layout

- `apps/cli/src`: commands and terminal output.
- `packages/agent/src`: local configuration and demo scan orchestration.
- `packages/detector/src`: pure availability comparison with explicit inconclusive results.
- `tests`: rule cases and CLI integration checks.
- `docs/execution-plan.md`: original product roadmap, not a description of completed features.

These directories currently share one TypeScript build and package manifest. Split them into npm workspaces when independently built packages are needed.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

## Next implementation work

1. Add read-only product and inventory collectors under `packages/shopify`, using the verified credential through `readStoredToken`.
2. Use the verified stored token in the read-only Shopify product and inventory collector.
3. Collect Admin inventory, storefront availability, and JSON-LD with matching variant IDs, timestamps, publication/market context, and raw evidence.
4. Persist incidents and regression assertions. Add polling and a localhost dashboard only when needed.

`scan` without `--demo` deliberately reports that live collection is unimplemented. `doctor` checks local configuration only; use `connect` to validate and store a Shopify token. The demo rule is simplified and must not be used as a live inventory verdict.

The previous Shopify web-app scaffold and its backup have been removed, as recorded in `docs/migration.md`. Local conversion does not delete or modify any existing registration in Shopify. The local CLI authenticates directly to the configured shop; it does not run inside Shopify Admin.
