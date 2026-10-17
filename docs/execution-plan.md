# StockTrail: local Shopify inventory truth agent

**Target:** portfolio-ready release by November 30, 2026  
**Distribution:** `npx stocktrail` / npm package  
**Interface:** command-line tool plus a dashboard on `localhost`  
**Shopify relationship:** uses Shopify APIs and webhooks, but is not an embedded Shopify Admin or App Store app

## 1. The product in one sentence

StockTrail is a local diagnostic agent that finds contradictions between a Shopify store's real inventory state and what shoppers or search engines can see, proves each problem with saved evidence, and generates a repeatable test that confirms the problem has been fixed.

The first version should answer one narrow but valuable question:

> Does Shopify say this variant is purchasable, does the live storefront agree, and does the product information exposed to search engines agree with both?

This gives the project a concrete merchant problem, a strong Shopify integration, and a memorable demonstration. A merchant can watch StockTrail detect a false `InStock` result, inspect why it happened, make or approve a correction, and rerun the same test until it passes.

## 2. What the merchant experiences

The happy path should look like this:

```text
npx stocktrail init
npx stocktrail scan
npx stocktrail dashboard
```

`stocktrail init` opens the browser for Shopify authorization, asks which products to monitor, and saves the configuration locally.

`stocktrail scan` collects inventory truth from Shopify, then visits the public product pages as a shopper and as a search crawler. It compares the evidence and creates incidents.

`stocktrail dashboard` starts a local server and opens a browser at a local address such as `http://localhost:4173`. The dashboard shows the scan, incidents, evidence, likely causes, suggested fixes, and runnable regression tests.

The more compelling demonstration is:

```text
npx stocktrail test
```

That command reruns the evidence attached to every unresolved incident. The result should read like a test suite:

```text
FAIL  Red Running Shoe / Size 10
      Shopify Admin: inventory = 0, policy = DENY
      Storefront: Add to cart button is enabled
      JSON-LD: availability = InStock
      Expected: storefront and search data should report unavailable

PASS  Blue Hiking Boot / Size 8
```

## 3. Why this is not a conventional Shopify app

Do not start the repository with `shopify app init`. Start it as a TypeScript monorepo containing a CLI, an agent, and a local web application.

A Shopify app registration is still useful because Shopify needs to know which client is requesting access. The registration supplies a client ID, redirect configuration, and requested scopes. It is an authorization identity, not the product's user interface.

StockTrail should support two connection modes:

1. **Development-token mode for the first demo.** The developer or merchant creates a Shopify custom app and gives StockTrail an Admin API access token. This is the fastest path for a development store. The token stays on the local machine.
2. **OAuth mode for the polished release.** `stocktrail connect` opens an authorization URL. A very small hosted callback exchanges the authorization code, then securely hands the result back to the local CLI. This removes the need for a merchant to paste a token.

Build token mode first. Add OAuth only after the detector and demo work end to end.

## 4. What makes StockTrail different

Inventory products usually focus on forecasting, replenishment, purchase orders, warehouse counts, or multichannel synchronization. StockTrail focuses on **inventory truth propagation**: whether an inventory change reaches every surface that influences a purchase or a search result.

Its distinctive pieces are:

- **Three perspectives on one product:** Shopify's internal state, the shopper-facing storefront, and machine-readable search data.
- **An evidence trail:** every conclusion links to the exact API fields, HTML, structured-data fragment, and observation time that produced it.
- **Runnable incident tests:** a detected problem becomes a permanent test instead of disappearing into a report.
- **A local-first design:** credentials and catalog evidence stay on the merchant's computer by default.
- **Deterministic detection:** the core result comes from explicit rules. An optional language model may explain an incident, but it never decides whether inventory is correct.

## 5. System design

```text
                         Shopify
                +------------------------+
                | Admin GraphQL API      |
                | Storefront/Ajax API    |
                | Webhooks (later)       |
                +-----------+------------+
                            |
                            v
+-------------+     +-------+--------+      +------------------+
| stocktrail  |---->| Collection     |----->| Normalized       |
| CLI         |     | adapters       |      | observations     |
+------+------+     +----------------+      +--------+---------+
       |                                              |
       | starts                                       v
       |                                     +--------+---------+
       |                                     | Rule engine      |
       |                                     | + test generator |
       |                                     +--------+---------+
       |                                              |
       v                                              v
+------+----------------------------------------------+---------+
| Local service                                                |
| SQLite database + job runner + HTTP API + React dashboard    |
+--------------------------------------------------------------+
```

### Runtime components

**CLI.** Parses commands, validates configuration, starts scans, prints progress, and starts the dashboard. Use TypeScript with `commander` or `oclif`.

**Collector.** Fetches data from Shopify and the live storefront. Each source adapter returns a common `Observation` shape so the rule engine does not depend on raw API responses.

**Rule engine.** Compares observations using ordinary TypeScript functions. Every rule has an ID, inputs, severity, explanation, and recommended next action.

**Test runner.** Stores the exact assertion created by an incident and recollects the required evidence later. A test passes only after the contradiction disappears.

**Local service.** A lightweight Node server exposes the dashboard API, runs work in the background, and stores state in SQLite.

**Dashboard.** A React interface served by the local service. It is a view over the same data used by the CLI, rather than a separate cloud product.

## 6. Technology choices

- Node.js 22 and TypeScript for the entire project.
- `commander` for a small, understandable CLI.
- React and Vite for the local dashboard.
- Shopify Polaris web components or Polaris React components for a Shopify-familiar interface.
- SQLite with Prisma for zero-configuration local persistence.
- Shopify's official Admin API client for authenticated GraphQL calls.
- Playwright for rendered product-page checks.
- Cheerio for quick HTML and JSON-LD parsing when a browser is unnecessary.
- Zod for validating configuration, API responses, and normalized observations.
- Vitest for rule-engine tests.
- `keytar` for operating-system credential storage if it works reliably on the supported platforms. Fall back to an encrypted local credential file, with the encryption key in the OS credential store.

SQLite is a better fit than PostgreSQL for this version because `npx stocktrail` should work without asking the merchant to install or host a database. PostgreSQL can be added if StockTrail later becomes a hosted multi-merchant product.

## 7. Shopify API integration

The project should make its Shopify usage visible in the code, documentation, UI, and demo.

### Admin GraphQL API: the source of operational truth

Request only the read scopes needed for the MVP, expected to include product and inventory reads. Confirm the current scope names and API version against Shopify's documentation when implementation begins.

For each selected product, query:

- product and variant IDs;
- title, handle, status, and publication state;
- variant SKU and selected options;
- inventory quantity or inventory item levels by location;
- inventory policy, such as whether overselling is permitted;
- tracked/untracked inventory state;
- product and variant update timestamps;
- online-store publication information where available.

Do not reduce inventory truth to `quantity > 0`. The normalizer should calculate a state such as:

```ts
type AdminAvailability = {
  productId: string;
  variantId: string;
  tracked: boolean;
  totalAvailable: number | null;
  continueSellingWhenOutOfStock: boolean;
  publishedToOnlineStore: boolean;
  expectedPurchasable: boolean;
  observedAt: string;
};
```

`expectedPurchasable` is derived from quantity, tracking, publication, and selling policy, with the derivation included in the evidence.

### Ajax Product API: what the storefront exposes

Fetch the public product JSON endpoint for the product handle when the theme supports it. Capture variant availability, IDs, prices, and the selected/default variant. This is an inexpensive comparison point between Admin state and the rendered page.

### Live product HTML and JSON-LD: what machines can read

Fetch the canonical product URL and parse every `application/ld+json` block. Locate `Product`, `ProductGroup`, and `Offer` objects and normalize:

- SKU or variant identifier;
- canonical URL;
- price and currency;
- `availability` such as `InStock` or `OutOfStock`;
- offer URL and selected-variant relationship.

Keep the raw JSON-LD fragment in the evidence record. This is the part of StockTrail that connects inventory errors to search visibility and merchant trust.

### Playwright: what a shopper can do

Open the product page in a real browser, select the variant, and record whether the add-to-cart control is enabled. If it is enabled, submit the add-to-cart action against the development store and capture the result. Use stable semantic selectors first and keep the MVP officially compatible with Shopify's Dawn theme.

### Webhooks: event-driven rescans

After manual scanning works, subscribe to relevant product and inventory update topics. The callback cannot point directly at a merchant's laptop, so the polished version needs a tiny relay service. The relay verifies Shopify's signature and sends only a wake-up event to a connected local agent; the agent then fetches authoritative details through the Admin API.

Webhooks are valuable but not required for the first end-to-end demo. Scheduled and manual scans are enough to prove the product before November 30.

## 8. Detection rules for the MVP

Ship three high-quality rules rather than many shallow ones.

### ST-001: Search data says in stock when Shopify says unavailable

Trigger when Admin evidence says a variant should not be purchasable, while its matching JSON-LD offer says `InStock`.

Impact: a search engine or shopping agent may send a customer to an unavailable item. The merchant gets a poor click and the customer loses trust.

### ST-002: Storefront permits purchase when Shopify says unavailable

Trigger when Admin evidence says unavailable, but the selected variant has an enabled add-to-cart action or the cart request succeeds.

Impact: the merchant may accept an order that cannot be fulfilled, unless overselling is explicitly configured.

### ST-003: Shopify says sellable but the storefront blocks the variant

Trigger when Admin evidence says the variant should be purchasable, but the storefront disables purchase or reports it unavailable.

Impact: real inventory exists but the merchant loses a possible sale.

Each rule must declare how variants are matched. Prefer Shopify variant IDs in URLs or page data, then SKU, then a combination of selected options. If the match is uncertain, report `inconclusive` rather than manufacturing an incident.

## 9. Incident and test model

Every incident should contain:

```ts
type Incident = {
  id: string;
  ruleId: "ST-001" | "ST-002" | "ST-003";
  shopDomain: string;
  productId: string;
  variantId: string;
  status: "open" | "resolved" | "ignored";
  severity: "high" | "medium";
  summary: string;
  likelyCause: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceIds: string[];
  regressionTestId: string;
};
```

The generated test is data, not newly generated JavaScript:

```json
{
  "ruleId": "ST-001",
  "variantId": "gid://shopify/ProductVariant/123",
  "assertion": "admin_expected_purchasable_equals_jsonld_in_stock"
}
```

The fixed rule implementation reads that assertion and reruns it. This avoids executing arbitrary generated code and makes tests stable enough to trust.

## 10. Safe fixes

The November version should diagnose and guide. It should not autonomously rewrite themes or alter inventory.

For each incident, provide:

- the most likely layer causing the disagreement;
- a short explanation in merchant language;
- the exact evidence that supports the conclusion;
- a suggested manual action;
- a **Copy fix instructions** action;
- a **Rerun test** action.

For the controlled Dawn demonstration, StockTrail may generate a patch preview showing the faulty and corrected Liquid or JSON-LD logic. Applying the patch should require explicit confirmation and should create a backup. General automatic theme editing belongs after the portfolio release.

An optional model provider can turn structured evidence into a friendlier explanation, but the dashboard must still work without an OpenAI or Anthropic key.

## 11. Local data layout

Default to a platform-appropriate application data directory rather than the project folder:

```text
stocktrail/
  config.json              # non-secret settings
  stocktrail.db            # SQLite database
  artifacts/
    scans/<scan-id>/
      admin.json
      storefront.json
      product.html
      jsonld.json
      screenshot.png
```

Store access tokens through the operating system credential manager. Redact tokens, customer data, and request headers from logs. Product and inventory evidence should have a configurable retention period, with a command to erase all local StockTrail data.

## 12. Repository layout

```text
stocktrail/
  apps/
    cli/                    # npx entry point and terminal output
    dashboard/              # local React interface
  packages/
    agent/                  # scan orchestration
    shopify/                # Admin, Ajax, page, and webhook adapters
    detector/               # normalization and ST-001..003
    test-runner/            # persisted regression assertions
    database/               # Prisma schema and repositories
    shared/                 # domain types, Zod schemas, logger
  fixtures/
    dawn-broken/            # reproducible bad storefront state
    dawn-fixed/             # corrected state or patch
  docs/
    architecture.md
    demo-script.md
    privacy.md
```

Keep API-specific code in `packages/shopify` and business rules in `packages/detector`. That separation makes it obvious that the project contains real Shopify engineering while keeping the core logic testable.

## 13. Dashboard screens

Keep the local UI to four screens:

1. **Overview:** last scan, monitored products, open contradictions, resolved contradictions, and a prominent Scan now button.
2. **Incidents:** filterable rows with product, variant, rule, severity, first seen, and current status.
3. **Incident detail:** a three-column comparison of Shopify truth, storefront behavior, and search data; evidence; cause; suggested action; and test history.
4. **Connection:** store domain, connection health, selected products, credential-storage status, and data-retention controls.

The incident detail screen is the centerpiece. It should visually demonstrate the contradiction without requiring the viewer to understand GraphQL or JSON-LD.

## 14. Eight-week execution plan

The schedule runs from October 3 through November 30. At two hours a day, the mathematical maximum is about 118 hours. Plan around roughly 100 focused hours and preserve the remainder for bugs, school, and setup delays.

Use six build sessions each week and keep one evening as recovery or catch-up. End every session with a small commit and a note naming the next concrete task.

### Week 1 — October 3–9: skeleton and Shopify connection

- Create the TypeScript workspace and packages.
- Add CLI commands with placeholder output.
- Create a Shopify development store and realistic sample products.
- Implement token-based configuration and secure local token storage.
- Make one Admin GraphQL query and print normalized product variants.
- Write the README's product statement and architecture diagram.

**Exit condition:** `stocktrail connect` and `stocktrail products` work against the development store.

### Week 2 — October 10–16: collect all three perspectives

Current implementation note: the combined `scan --product-id <gid>` command now collects and atomically persists Admin, cookieless Ajax, HTML, and inline JSON-LD evidence. It reports source outcomes only. The contradiction rules, incidents, scoring, regression assertions, rendered-browser actions, and remediation described in later weeks remain intentionally deferred.

- Add Admin inventory and selling-policy collection.
- Add Ajax product collection.
- Fetch product HTML and parse JSON-LD.
- Save raw and normalized evidence in SQLite and artifact files.
- Show one product's three perspectives in terminal output.

**Exit condition:** one command produces an evidence bundle for a selected Dawn product.

### Week 3 — October 17–23: deterministic detective

Current implementation note: the Phase 3 core and approved Playwright integration are implemented. `scan --browser --product-id <gid>` adds isolated Dawn evidence, evaluates ST-001 through ST-003, calculates the full 30/25/20/15/10 readiness score from fresh normalized Admin content and timestamps, and persists incidents and regression assertions. Missing or invalid Admin content makes only the dependent components inconclusive and is never printed. `--cart-add` is the explicit mutation opt-in; checkout remains blocked. `test --browser` reruns stored assertions from fresh evidence, while plain `test` retains its safe inconclusive behavior for browser-dependent assertions.

Phase 4 implementation note: deterministic product-content proposals are implemented for `title`, `descriptionHtml`, `seo.title`, and `seo.description` only. Generation is local and extractive, unsafe edits remain guidance-only, and every write requires a fresh stale check plus explicit per-proposal approval. The write path requires `write_products`, makes one `productUpdate` attempt, reconciles uncertain outcomes without retrying, and runs the Phase 3 browser scan afterward with cart submission disabled. Reverts are separate proposals with separate approval. The local React dashboard remains Phase 5 work and is intentionally not part of this phase.

- Implement strict variant matching.
- Implement ST-001, ST-002, and ST-003.
- Create fixtures for matching, contradictory, and inconclusive evidence.
- Add meaningful unit tests around selling policy, untracked inventory, and ambiguous variants.
- Produce a clean terminal incident report.

**Exit condition:** a seeded inventory/search contradiction is detected reliably with no language model.

### Week 4 — October 24–30: real-browser proof and runnable tests

- Add the Dawn Playwright adapter.
- Select a variant and observe the add-to-cart state.
- Persist incidents and evidence relationships.
- Persist data-driven regression tests.
- Implement `stocktrail test` and pass/fail terminal output.

**Exit condition:** the intentionally broken case fails, and the corrected case passes using the same stored test.

### Week 5 — October 31–November 6: local dashboard

- Start the local API and dashboard from the CLI.
- Build Overview and Incidents screens.
- Build the three-perspective incident detail view.
- Add evidence links, screenshots, likely cause, and rerun action.
- Use a small set of polished empty, loading, error, and success states.

**Exit condition:** a viewer can understand the problem and proof from the dashboard alone.

### Week 6 — November 7–13: agent loop and resilience

- Add product selection and scheduled local rescans.
- Deduplicate recurring incidents while updating `lastSeenAt`.
- Add retry, rate-limit handling, timeouts, and cancellation.
- Add `stocktrail doctor` for configuration and connection checks.
- Redact secrets and implement local-data deletion.

**Exit condition:** the tool can run repeatedly without creating duplicate incidents or leaking credentials.

### Week 7 — November 14–20: installation and controlled fix demo

- Package the CLI so it runs from a clean machine with `npx` or `npm link` during development.
- Create the Dawn broken/fixed fixture or a safe patch preview.
- Add copyable fix guidance and a rerun-test action.
- Test on Windows and, through CI, at least one Unix environment.
- Ask one Shopify developer or merchant to attempt setup without coaching.

**Exit condition:** a new user can connect, scan, inspect, fix, and retest from the README.

### Week 8 — November 21–27: evaluation and presentation

- Seed at least 20 varied cases and calculate rule precision on them.
- Measure scan duration and API calls for 10 products.
- Record known limitations: Dawn only, one locale/market, ordinary physical variants.
- Write the architecture, privacy, and evaluation documents.
- Record a 60–90 second demo and capture strong screenshots.
- Prepare the public launch post around the measurable before/after story.

**Exit condition:** the repository proves the claim with metrics, tests, documentation, and a short demo.

### Buffer — November 28–30: release

- Fix only release-blocking bugs.
- Run the clean-machine setup one last time.
- Tag `v0.1.0` and publish the npm package if ready.
- Make the repository public and publish the demo.

Do not add new features during the buffer.

## 15. Definition of done for November 30

StockTrail is finished for the portfolio release when all of these are true:

- It installs from a single documented command on a clean machine.
- It securely connects to a Shopify development store.
- It uses the Admin GraphQL API and live storefront data in the normal execution path.
- It scans at least 10 selected products.
- It detects the three defined contradiction classes.
- Every incident includes raw evidence and a human-readable explanation.
- It turns an incident into a stored test that fails before a fix and passes afterward.
- Its local dashboard tells the full story without terminal knowledge.
- The core rule tests and one end-to-end demo pass in CI.
- The repository includes a clear README, architecture document, limitations, privacy approach, and demo video.

OAuth, webhook relaying, automatic theme editing, broad theme support, multiple markets, forecasting, and App Store submission are post-release work. They should not threaten the November deadline.

## 16. The launch demonstration

Use one development-store product with two variants. Deliberately make the JSON-LD availability calculation use product-level availability, so the sold-out variant is incorrectly described as `InStock`.

The video should show this sequence:

1. Shopify Admin shows the selected variant at zero inventory with overselling disabled.
2. The live page or its JSON-LD still claims that variant is in stock.
3. `npx stocktrail scan` finds ST-001.
4. The local dashboard shows all three evidence sources side by side.
5. `npx stocktrail test` fails the saved regression test.
6. The theme logic is corrected.
7. The same test passes and the incident resolves.

That is the project's central story: StockTrail follows inventory facts from Shopify to the storefront and search layer, leaves an audit trail, and proves that the repair stays repaired.

## 17. Start tonight

For the first two-hour session:

1. Create the repository and npm workspace.
2. Add `apps/cli` and a `stocktrail --help` command.
3. Create or open the Shopify development store.
4. Create a custom app for local development and grant the minimum product/inventory read access.
5. Put the shop domain in a local config file and the token in the OS credential store or a temporary ignored environment file.
6. Query five products with Admin GraphQL and print their titles and variant IDs.
7. Commit with a short README that states the product promise.

Stop after the first successful real Shopify query. That gives the project a working spine on night one and makes every later feature an extension of verified API access.
