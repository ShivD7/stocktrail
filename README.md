# StockTrail

StockTrail is a local-first Shopify diagnostic CLI and localhost dashboard. It
compares Shopify Admin inventory with storefront and search evidence, identifies
availability contradictions, stores regression checks, and creates narrowly scoped
product-content proposals. It does not run inside Shopify Admin, host a service, or
modify Shopify unless you explicitly approve a supported proposal.

The v0.1.0 source release is available on GitHub. The npm package is private and
unpublished; install from this repository.

## Install

Requirements: Node.js 22.13+ (Node 24 recommended) and npm.

```powershell
git clone https://github.com/ShivD7/stocktrail.git
cd stocktrail
npm ci
npx playwright install chromium   # required for browser scans/tests
```

## Offline demo

The demo uses synthetic fixtures and makes no Shopify requests:

```powershell
npm run dev -- scan --demo
```

## Shopify workflow

1. Configure the store:

   ```powershell
   npm run dev -- init --shop your-store.myshopify.com
   ```

2. Connect with a Shopify Admin API token:

   ```powershell
   npm run dev -- connect
   npm run dev -- doctor --live
   ```

   The token is verified and stored in the operating-system credential store. It
   is not written to `config.json`, source files, logs, or reports.

3. Import and select products:

   ```powershell
   npm run dev -- import --preview --limit 5
   npm run dev -- import
   npm run dev -- monitor candidates
   npm run dev -- monitor add --product-id <product-gid>
   ```

   StockTrail keeps the catalog and evidence locally. Imports are read-only and
   support up to ten monitored products.

4. Scan a monitored product:

   ```powershell
   npm run dev -- scan --product-id <product-gid>
   npm run dev -- scan --browser --product-id <product-gid>
   npm run dev -- test --browser
   ```

   A combined scan compares Admin, Ajax, HTML/JSON-LD, and—when `--browser` is
   used—rendered Dawn storefront behavior. Ambiguous or incomplete evidence is
   reported as inconclusive. Cart submission is disabled unless you explicitly
   add `--cart-add`; checkout is never attempted.

## Dashboard and proposals

Start the local dashboard with:

```powershell
npm run dev -- dashboard --no-open
```

It binds to `127.0.0.1` and uses the same local database and evidence as the CLI.

Review deterministic content proposals before any supported write:

```powershell
npm run dev -- improve --product-id <product-gid>
npm run dev -- proposal list
npm run dev -- proposal status <proposal-id>
npm run dev -- apply <proposal-id>
npm run dev -- revert <applied-proposal-id>
```

Applying a proposal requires explicit confirmation, the `write_products` scope,
fresh stale-content validation, reconciliation, and a verification scan. Reverts
create another proposal and never apply automatically.

## Scheduling and maintenance

Schedules run one pass at a time when invoked by Windows Task Scheduler or cron:

```powershell
npm run dev -- schedule set --interval-minutes 60
npm run dev -- schedule run
npm run dev -- schedule status
```

Useful local commands:

```powershell
npm run dev -- doctor
npm run dev -- logout
npm run dev -- delete-data --confirm your-store.myshopify.com
```

Use `STOCKTRAIL_HOME` to keep data in a chosen absolute directory. Never put
tokens or private catalog/evidence data in source control, fixtures, logs, or
screenshots.

## Important limits

- StockTrail targets Dawn-compatible storefronts, ordinary physical variants, and
  one locale/market context at a time.
- A diagnostic score is not an SEO ranking, revenue forecast, or checkout guarantee.
- Browser scans block third-party traffic, WebSockets, checkout, accounts, orders,
  payments, downloads, screenshots, traces, and video.
- The package is not published to npm. Use the checkout, `npm link`, or the GitHub
  source release rather than `npx stocktrail`.

## Development

```powershell
npm run typecheck
npm test
npm run build
npm run test:pack
npm run release:check
```

## Source map and detailed documentation

- `apps/cli/src`: CLI commands and terminal output.
- `apps/dashboard`: localhost API and React dashboard.
- `packages/agent/src`: workflows, configuration, credentials, scheduling.
- `packages/shopify/src`: Shopify Admin and storefront adapters.
- `packages/detector/src`: availability comparison rules.
- `packages/database/src`: SQLite persistence and migrations.
- `tests`: unit, integration, browser, and release-readiness tests.

See [architecture](docs/architecture.md), [privacy](docs/privacy.md),
[limitations](docs/limitations.md), [release checklist](docs/release-checklist.md),
and [migration notes](docs/migration.md) for details.
