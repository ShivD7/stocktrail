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
npm run dev -- scan --product-id gid://shopify/Product/123
npm run dev -- scan --admin --product-id gid://shopify/Product/123
npm run dev -- scan --ajax --product-id gid://shopify/Product/123
npm run dev -- scan --demo
npm run dev -- test
```

The demo uses two synthetic products, prints one FAIL and one PASS, and saves a JSON evidence report under `.stocktrail/reports`. It makes no network requests. A diagnostic contradiction exits with code **2**; command/configuration errors exit with **1**; success exits with **0**.

Configuration is created once in `.stocktrail/config.json` under the current directory. Repeating `init` never overwrites it. Omit `--shop` to try the offline demo. Set `$env:STOCKTRAIL_HOME` to an absolute directory if you want one data location across working directories. Configuration and evidence are ignored by Git. Do not put tokens in config.json.

`connect` (also available as `login`) prompts for a Shopify Admin API token without displaying it, verifies the store identity and the `read_products` scope against Shopify Admin GraphQL API version `2026-10`, and only then saves the token. StockTrail uses Windows Credential Manager, macOS Keychain, or a Linux Secret Service provider. On Linux, the desktop keyring must be installed, running, and unlocked. The token is keyed by the configured `*.myshopify.com` hostname and is never written to `config.json` or diagnostic output.

`import --preview` reads products and all variants through Admin GraphQL, normalizes them in memory, and prints aggregate counts only. It does not write database, catalog, report, or evidence files and never sends a Shopify mutation. Its `--limit` defaults to 5.

`import` performs the same read-only Shopify collection and transactionally upserts the normalized catalog into `.stocktrail/stocktrail.sqlite`; it never modifies Shopify. Its `--limit` defaults to 250, and all limits accept whole numbers from 1 to 250. Repeating an import updates matching Shopify GIDs without duplicates. A complete snapshot marks missing products and variants inactive instead of deleting them. A limited snapshot leaves unseen products unchanged, while still marking variants missing from an imported product inactive. Each new import records only safe batch provenance (observation time, `shopify_admin_graphql`, and API version `2026-10`) alongside both sellable-online quantity and diagnostic inventory quantity. Request IDs, headers, tokens, raw GraphQL, and query-cost metadata are not persisted.

After an import, use `monitor candidates` to show active local Shopify product GIDs and whether each is selected. Selected products that later disappear from Shopify remain visible as `monitored inactive` so they can be removed. Candidate output intentionally omits titles, descriptions, handles, SKUs, and other catalog content. Select up to ten active products with `monitor add --product-id gid://shopify/Product/123`, remove one with `monitor remove --product-id gid://shopify/Product/123`, or inspect safe aggregate selection counts with `monitor list`.

`scan --admin --product-id <gid>` collects read-only Admin GraphQL evidence for one active, locally imported, monitored product and saves it atomically under `.stocktrail/reports`. It records an observation window, publication status, Admin timestamps, Online Store sellable quantity, diagnostic inventory quantity, and inventory tracking state. Terminal output is aggregate-only: it reports variant and page counts plus a generic local-save confirmation, without printing the product ID, timestamps, absolute paths, or catalog content. This mode is explicitly **Admin only**: it does not inspect the storefront, Ajax responses, HTML, or JSON-LD and cannot establish a storefront availability verdict.

`scan --ajax --product-id <gid>` first obtains fresh Admin evidence for the same eligible product, then derives a product JSON endpoint only from that fresh Online Store URL. It makes a cookieless public request from the CLI's own network and locale path, matches product and variant identities exactly, and saves only normalized fields, aggregate counts, response metadata, and a body hash. Redirects are not followed, DNS results are checked against private and reserved networks, and the request is pinned to a validated address. A product without an Online Store URL produces an inconclusive local report without making a public request. This is **Ajax-only evidence** from one request context—not a cart, checkout, browser-session, market-wide, or universal shopper verdict. Terminal output remains aggregate-only and does not reveal the URL, handle, product ID, timestamps, or report path.

`scan --product-id <gid>` is the combined Phase 2 collection command. It validates eligibility once, reads fresh Admin evidence once, and collects cookieless Ajax JSON plus product HTML derived only from the fresh Online Store URL. Inline JSON-LD is tokenized and parsed without executing scripts or following discovered URLs. The run is staged privately and atomically published beneath the local evidence-artifact area; SQLite stores only product-linked integrity and index metadata. A public-source failure produces a partial bundle and still exits successfully, while eligibility, Admin, or secure-storage failures exit with an error. Terminal output contains aggregate source outcomes only. This command collects evidence—it does not declare PASS/FAIL, detect contradictions, score incidents, or recommend remediation.

The Phase 3 deterministic core is implemented separately from the live scan: strict ID/SKU/options matching, Admin purchasability derivation, ST-001 through ST-003, the weighted Inventory Search Readiness diagnostic, incident lifecycle persistence, and data-only regression assertions. Synthetic Dawn fixtures exercise broken and corrected states offline. Until the approved browser runtime is integrated, `stocktrail test` never fabricates a browser result: stored live assertions are reported explicitly as inconclusive and exit with code **3**. A remaining contradiction exits with **2**, an operational error with **1**, and an all-pass or empty test run with **0**.

Run `npm run dev -- logout` to delete the configured store's token from the OS credential store. A failed verification leaves any existing saved credential unchanged. Read-only Admin import and evidence commands retrieve this credential through the Shopify adapter; it is never sent to the public Ajax endpoint.

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

1. Integrate approved Dawn browser evidence into the live bundle and diagnostic pipeline.
2. Feed fresh live diagnostic evaluations into the existing incident and regression-test repositories.
3. Add broader browser contexts, polling, and a localhost dashboard only when needed.

The combined scan is collection-only; standalone `scan --admin`, `scan --ajax`, and offline `scan --demo` remain available. `doctor` checks local configuration only; use `connect` to validate and store a Shopify token. The demo rule is simplified and must not be used as a live inventory verdict.

The previous Shopify web-app scaffold and its backup have been removed, as recorded in `docs/migration.md`. Local conversion does not delete or modify any existing registration in Shopify. The local CLI authenticates directly to the configured shop; it does not run inside Shopify Admin.
