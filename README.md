# StockTrail

A local diagnostic CLI for comparing Shopify inventory with what shoppers and search engines see. This repository is now a CLI starter. It does not run an embedded Shopify app or require a web server, tunnel, or deployment.

## Quick start (PowerShell)

Use Node.js 24 (or Node.js 22.13+) and npm.

```powershell
npm install
npm run dev -- --help
npm run dev -- init --shop your-store.myshopify.com
npm run dev -- connect
npm run dev -- doctor
npm run dev -- import --preview --limit 5
npm run dev -- import
npm run dev -- monitor candidates
npm run dev -- monitor list
npm run dev -- scan --demo
```

The demo uses two synthetic products, prints one FAIL and one PASS, and saves a JSON evidence report under `.stocktrail/reports`. It makes no network requests. A diagnostic contradiction exits with code **2**; command/configuration errors exit with **1**; success exits with **0**.

Configuration is created once in `.stocktrail/config.json` under the current directory. Repeating `init` never overwrites it. Omit `--shop` to try the offline demo. Set `$env:STOCKTRAIL_HOME` to an absolute directory if you want one data location across working directories. Configuration and evidence are ignored by Git. Do not put tokens in config.json.

`connect` (also available as `login`) prompts for a Shopify Admin API token without displaying it, verifies the store identity and the `read_products` scope against Shopify Admin GraphQL API version `2026-10`, and only then saves the token. StockTrail uses Windows Credential Manager, macOS Keychain, or a Linux Secret Service provider. On Linux, the desktop keyring must be installed, running, and unlocked. The token is keyed by the configured `*.myshopify.com` hostname and is never written to `config.json` or diagnostic output.

`import --preview` reads products and all variants through Admin GraphQL, normalizes them in memory, and prints aggregate counts only. It does not write database, catalog, report, or evidence files and never sends a Shopify mutation. Its `--limit` defaults to 5.

`import` performs the same read-only Shopify collection and transactionally upserts the normalized catalog into `.stocktrail/stocktrail.sqlite`; it never modifies Shopify. Its `--limit` defaults to 250, and all limits accept whole numbers from 1 to 250. Repeating an import updates matching Shopify GIDs without duplicates. A complete snapshot marks missing products and variants inactive instead of deleting them. A limited snapshot leaves unseen products unchanged, while still marking variants missing from an imported product inactive. Each new import records only safe batch provenance (observation time, `shopify_admin_graphql`, and API version `2026-10`) alongside both sellable-online quantity and diagnostic inventory quantity. Request IDs, headers, tokens, raw GraphQL, and query-cost metadata are not persisted.

After an import, use `monitor candidates` to show active local Shopify product GIDs and whether each is selected. Selected products that later disappear from Shopify remain visible as `monitored inactive` so they can be removed. Candidate output intentionally omits titles, descriptions, handles, SKUs, and other catalog content. Select up to ten active products with `monitor add --product-id gid://shopify/Product/123`, remove one with `monitor remove --product-id gid://shopify/Product/123`, or inspect safe aggregate selection counts with `monitor list`.

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
- `packages/agent/src`: local configuration, credentials, and workflow orchestration.
- `packages/shopify/src`: read-only Shopify Admin adapters and catalog collection.
- `packages/shared/src`: shared domain validation and normalized catalog types.
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

1. Add storefront availability and JSON-LD collection with matching variant IDs, timestamps, and market context.
2. Persist evidence, incidents, and regression assertions after their schemas are defined.
3. Add polling and a localhost dashboard only when needed.

`scan` without `--demo` deliberately reports that live collection is unimplemented. `doctor` checks local configuration only; use `connect` to validate and store a Shopify token. The demo rule is simplified and must not be used as a live inventory verdict.

The previous Shopify web-app scaffold and its backup have been removed, as recorded in `docs/migration.md`. Local conversion does not delete or modify any existing registration in Shopify. The local CLI authenticates directly to the configured shop; it does not run inside Shopify Admin.
