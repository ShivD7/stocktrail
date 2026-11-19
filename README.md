# StockTrail

A local CLI and dashboard for checking Shopify inventory against the storefront.

## Features

* Imports a Shopify catalog and monitors up to ten products.
* Compares Admin inventory with Ajax, HTML, JSON-LD, and rendered storefront evidence.
* Matches variants and flags conflicting availability claims.
* Marks incomplete or ambiguous results as inconclusive.
* Saves evidence, incidents, scan history, and regression checks locally.
* Scores inventory search readiness from availability, variant identity, structured data, and content.
* Reruns checks from the CLI or dashboard.
* Creates content proposals from existing product text.
* Removes standalone temporary inventory claims or fills empty SEO fields.
* Reviews, applies, verifies, and reconciles supported product changes.
* Creates revert proposals for applied changes.
* Runs scheduled scan passes through Task Scheduler or cron.
* Stores Shopify tokens in the operating system credential store.
* Includes setup checks, scan performance measurement, logout, and local data deletion.
* Runs an offline demo using synthetic data.

## Download and install

You need Git, npm, and Node.js 22.13 or newer. Node 24 is recommended.

Clone the repository.

```powershell
git clone https://github.com/ShivD7/stocktrail.git
cd stocktrail
npm ci
npx playwright install chromium
```

You can use GitHub's **Code** menu and choose **Download ZIP** instead. Extract the ZIP, open a terminal in the extracted folder, then run the last two commands.

Chromium is needed for browser scans. The npm package is unpublished, so install from this repository.

## Try the demo

```powershell
npm run dev -- scan --demo
```

The demo uses fixtures and makes no Shopify requests.

## Connect a store

Use a Shopify Admin API token with `read_products` access. The connect command prompts for it and stores it in your system credential store.

```powershell
npm run dev -- init --shop your-store.myshopify.com
npm run dev -- connect
npm run dev -- doctor --live
npm run dev -- import --preview --limit 5
npm run dev -- import
npm run dev -- monitor candidates
```

Copy a product GID from the candidates list. Replace `PRODUCT_GID` in these commands.

```powershell
npm run dev -- monitor add --product-id PRODUCT_GID
npm run dev -- scan --browser --product-id PRODUCT_GID
npm run dev -- test --browser
```

## Open the dashboard

```powershell
npm run dev -- dashboard
```

The dashboard runs on `127.0.0.1` and uses the same local data as the CLI. Add `--no-open` to start it without opening a browser.

## Content proposals

Generate a proposal, then review its details before applying it.

```powershell
npm run dev -- improve --product-id PRODUCT_GID
npm run dev -- proposal list
npm run dev -- proposal status PROPOSAL_ID
npm run dev -- apply PROPOSAL_ID
npm run dev -- revert APPLIED_PROPOSAL_ID
```

Replace the uppercase placeholders with actual IDs. Applying a change requires confirmation and `write_products` access. A revert creates a new proposal for review.

## Scheduled scans

```powershell
npm run dev -- schedule set --interval-minutes 60
npm run dev -- schedule run
npm run dev -- schedule status
```

Use Task Scheduler or cron to call `schedule run` regularly. Each call checks whether a scan is due, then exits.

## Limits

Checks target Dawn-compatible storefronts and ordinary physical variants in one market and locale at a time. They do not prove checkout success, search ranking, or sales impact.

Store access is read-only by default. Cart submission requires `--cart-add`. Checkout is never attempted.

See the [limitations](docs/limitations.md), [privacy notes](docs/privacy.md), and [architecture](docs/architecture.md) for details.
