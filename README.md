# StockTrail

A local diagnostic CLI and localhost dashboard for comparing Shopify inventory with what shoppers and search engines see. It is not an embedded Shopify app and requires no tunnel or deployment.

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
npm run dev -- scan --browser --product-id gid://shopify/Product/123
npm run dev -- scan --browser --cart-add --product-id gid://shopify/Product/123
npm run dev -- scan --admin --product-id gid://shopify/Product/123
npm run dev -- scan --ajax --product-id gid://shopify/Product/123
npm run dev -- scan --demo
npm run dev -- test
npm run dev -- test --browser
npm run dev -- improve --product-id gid://shopify/Product/123
npm run dev -- proposal list
npm run dev -- proposal status <proposal-id>
npm run dev -- apply <proposal-id>
npm run dev -- revert <applied-proposal-id>
npm run dev -- dashboard
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

Add `--browser` to a combined scan to collect rendered Dawn storefront evidence in Playwright and run ST-001 through ST-003. Each variant uses a fresh, nonpersistent Chromium context. StockTrail verifies the exact product, variant, single visible product form, and single visible add control; ambiguous or unsupported pages are inconclusive. DNS is checked against private and reserved networks, navigation is pinned to a validated public address, third-party requests and WebSockets are blocked, and checkout/account/payment routes are always blocked. The normal browser scan observes control state only. `--cart-add` is the explicit authorization for an isolated add-to-cart probe; it requires an initially empty cart and always attempts verified cleanup. Checkout is never attempted.

Browser scans save a version 2 evidence bundle, deterministic rule evaluations, incident lifecycle updates, regression assertions, and the weighted Inventory Search Readiness diagnostic. The 30/25/20/15/10 score uses fresh normalized Admin title, description, SEO, product-update, and latest inventory-update evidence for inventory-promise clarity and stale-claim safety; missing or invalid content makes those components explicitly inconclusive. Product content is never printed—the terminal remains aggregate-only. `stocktrail test --browser` reruns stored assertions with fresh evidence; add `--cart-add` only when that mutation is intended. Plain `stocktrail test` preserves the safe non-browser behavior and reports browser-dependent assertions as inconclusive. A contradiction exits with **2**, an inconclusive browser run with **3**, an operational error with **1**, and an all-pass or empty run with **0**. Scope remains Dawn-compatible product forms, one locale/market, and ordinary physical variants.

`improve --product-id <gid>` uses the latest integrity-checked Phase 3 browser diagnostic to create one deterministic local proposal. It can only remove complete standalone transient inventory claims or copy existing content exactly into an empty SEO field. Mixed claims, unsupported HTML, missing provenance, information loss, length violations, or score regressions remain guidance-only. It makes no Shopify request. Proposal content is stored in private integrity-indexed artifacts; SQLite stores lifecycle and audit metadata only.

Review proposals with `proposal list` and `proposal status <id>`. Reject one locally with `proposal reject <id>`. `apply <id>` prints the field-level diff and requires typing `APPLY <full-id>`; a noninteractive run requires `--approve <same-full-id>`. The apply path requires the exact `write_products` scope, performs a fresh byte-for-byte stale check, makes at most one `productUpdate` attempt, reconciles uncertain responses with a fresh read, and never blindly retries. A confirmed update triggers the normal Phase 3 browser scan with cart submission disabled. Stale or ambiguous outcomes exit with **4**. Use `proposal status <id> --reconcile` for a read-only refresh of an ambiguous or unverified outcome.

`revert <applied-id>` creates a new proposal from the original private before snapshot; it never writes automatically. Applying that proposal requires typing `REVERT <full-id>`. If restoring the prior content would reintroduce a transient claim or lower readiness, `--acknowledge-revert-risk` is also required. Phase 4 does not edit themes, inventory, variants, prices, handles, status, publications, tags, metafields, or checkout behavior, and it does not use a language model.

`dashboard` starts the React interface at `http://127.0.0.1:4173` and opens it in the default browser. Use `--port <1-65535>` to choose another loopback port or `--no-open` to keep the browser closed. Its local API exposes strict product, incident, proposal, connection, import, monitoring, scan, improve, rerun, apply, reconcile, reject, and revert contracts over the same SQLite index and integrity-checked artifacts used by the CLI. Evidence HTML is served as plain text and API responses are never cached. Every request must use the exact bound `127.0.0.1:<port>` authority; every mutation must also use the exact matching Origin, and no CORS access is granted. Incident reruns execute only that incident's active shop-scoped assertion against fresh browser evidence, always with cart submission disabled. Press Ctrl+C in the starting terminal to stop the service.

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
- `apps/dashboard`: loopback HTTP API and local React/Vite interface.
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

1. Add broader theme adapters and explicit market/locale contexts.
2. Add scheduled polling and incident deduplication resilience.
3. Add remediation previews after the diagnostic workflow is stable.

The combined scan without `--browser` remains collection-only; standalone `scan --admin`, `scan --ajax`, and offline `scan --demo` remain available. `doctor` checks local configuration only; use `connect` to validate and store a Shopify token. The demo rule is simplified and must not be used as a live inventory verdict.

The previous Shopify web-app scaffold and its backup have been removed, as recorded in `docs/migration.md`. Local conversion does not delete or modify any existing registration in Shopify. The local CLI authenticates directly to the configured shop; it does not run inside Shopify Admin.
