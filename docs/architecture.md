# Architecture

## Product boundary

StockTrail is a local-first Shopify diagnostic CLI with a localhost dashboard. It
imports catalog state, collects evidence from Shopify Admin and the public
storefront, evaluates deterministic availability rules, stores regression
assertions, and can prepare narrowly constrained product-content proposals. It is
not an embedded Shopify app, hosted service, inventory manager, or general theme
editor.

The implementation is a single TypeScript package today. The folders express
logical boundaries without being independent npm workspaces.

```text
CLI / localhost React dashboard
              |
              v
      agent orchestration
       /      |       \
Shopify    detector   proposals/scorer/test runner
adapters       |       /
       \       |      /
        SQLite index + private artifacts
```

## Source map

| Location | Responsibility |
| --- | --- |
| `apps/cli/src` | Argument validation, terminal prompts, safe aggregate output, and exit codes. |
| `apps/dashboard` | Loopback HTTP API, browser launch, React UI, and dashboard actions. |
| `packages/agent/src` | Workflows spanning configuration, credentials, adapters, persistence, scheduling, and deletion. |
| `packages/shopify/src` | Admin GraphQL, public Ajax/HTML collection, JSON-LD extraction support, Dawn browser observation, and the approved product mutation. |
| `packages/detector/src` | Variant matching, expected availability, and ST-001 through ST-003. |
| `packages/scorer/src` | Deterministic Inventory Search Readiness calculation. |
| `packages/proposals/src` | Conservative proposal generation, validation, provenance replay, and field diffs. |
| `packages/test-runner/src` | Stored data-driven assertion execution. |
| `packages/database/src` | SQLite migrations and repositories for catalog, evidence indexes, incidents, tests, scores, proposals, and schedules. |
| `packages/shared/src` | Zod schemas and portable domain types. |
| `fixtures/evaluation` | Synthetic rule and adversarial proposal corpora. |

## Main data flows

### Connection and catalog import

1. `init` writes a non-secret shop configuration under `.stocktrail` or
   `STOCKTRAIL_HOME`.
2. `connect` verifies the shop identity and product-read capability, then saves the
   token through the operating-system credential store.
3. `import` reads paginated Admin GraphQL products and variants, validates them,
   then transactionally upserts them into SQLite.
4. Shopify GIDs make imports idempotent. Complete snapshots soft-deactivate
   missing records; limited snapshots do not treat unseen products as deleted.
5. Up to ten active imported products can be selected for monitoring.

`import --preview` stops after in-memory normalization and prints counts. It does
not open the catalog database or save evidence.

### Evidence and diagnostics

`scan --product-id <gid>` validates that the product is active, imported, and
monitored. It then collects one fresh Admin observation and derives public Ajax and
HTML targets only from that observation's Online Store URL. JSON-LD is parsed as
data; scripts and discovered URLs are not executed or followed.

Evidence files are staged, hashed, validated as a bundle, and atomically renamed
into `artifacts/scans/<run-id>`. SQLite stores the run, source outcomes, artifact
paths, hashes, sizes, and relationships. If indexing fails, the newly published
bundle is removed.

Adding `--browser` creates a fresh, nonpersistent Chromium context per variant.
The Dawn adapter selects the exact variant and observes one visible product form
and add control. It blocks third-party requests, WebSockets, account, checkout,
order, and payment routes. `--cart-add` separately authorizes an isolated cart
probe with an initially empty cart and verified cleanup.

Browser-backed scans run:

- ST-001: JSON-LD says `InStock` while Admin says unavailable.
- ST-002: the storefront permits purchase while Admin says unavailable.
- ST-003: Admin says sellable while the storefront blocks purchase.

Uncertain identity or incomplete evidence becomes `inconclusive`; it is not forced
into pass or fail. Evaluations update incident lifecycles, create data-driven
regression assertions, and feed the deterministic readiness score.

### Regression tests and proposals

`test --browser` recollects fresh browser evidence for stored assertions. Plain
`test` avoids browser/network collection and reports browser-dependent assertions
as inconclusive.

`improve` creates a local proposal only from integrity-checked evidence. Supported
changes are deliberately narrow: remove a complete standalone transient inventory
claim, or copy existing title/description content into an empty SEO field. Proposal
artifacts contain before/candidate content and field-level diffs.

`apply` requires the `write_products` scope, a full proposal identifier as explicit
approval, and a fresh byte-for-byte stale check. It performs at most one
`productUpdate` attempt, reconciles uncertain outcomes with a fresh read, then runs
a verification scan with cart submission disabled. `revert` creates another
proposal; it never writes automatically.

### Dashboard and scheduling

`dashboard` binds only to `127.0.0.1`. The API validates response contracts,
requires the exact Host for all requests and matching Origin for mutations, applies
no CORS grant, and serves stored HTML evidence as plain text. The React interface
contains Overview, Products, Incidents, Connection, product detail, incident
detail, and proposal review views.

A saved schedule is configuration, not a resident daemon. An operating-system
scheduler must invoke `schedule run`. A run claims the schedule atomically, scans
active monitored products sequentially, prevents overlap, isolates product
failures, and releases its claim on graceful cancellation. A later invocation may
atomically reclaim a persisted active claim once its recorded start is at least six
hours old. That recovers after a hard process kill; the tradeoff is that operators
must not treat a legitimate scan lasting six hours as protected from takeover.

## Storage model and trust boundaries

- The OS credential store owns the Admin token.
- SQLite is the queryable local index and lifecycle store.
- Private artifacts hold evidence and proposal content; hashes and sizes in SQLite
  provide integrity checks before reuse.
- Shopify Admin is the authenticated operational source.
- Ajax, HTML, JSON-LD, and browser observations describe one public request context.
- The dashboard trusts the local machine and is not a remotely authenticated web
  application.

See [Privacy](privacy.md) for stored data and network controls.

## Failure and consistency model

- SQLite migrations use `PRAGMA user_version` and reject a database created by a
  newer StockTrail schema.
- Catalog writes, monitoring updates, diagnostic lifecycle updates, proposals, and
  schedule claims use transactions.
- Read-only Admin calls have bounded retry behavior; mutations are never retried
  blindly.
- Partial public-source collection produces a partial evidence bundle rather than
  an invented conclusion.
- Artifact publication and SQLite indexing are coordinated with cleanup on failure.
- Central error redaction is a last line of defense; adapters also avoid placing
  response bodies and secrets in errors.

## Resume-friendly project summary

The v0.1.0 source release includes the end-to-end implementation through Phase 6:
secure token mode, idempotent import, monitoring, combined evidence, Dawn browser diagnostics,
incidents, regression assertions, readiness scoring, constrained proposals,
explicit product-content writes and revert proposals, the dashboard, scheduled
runs, resilience controls, deletion, CI configuration, packaging smoke tests, and
synthetic evaluation.

The npm distribution and pending validation assets are separate from the source
release. Continue at [Release checklist](release-checklist.md): run the local verification
commands, confirm the remote Windows/Ubuntu workflow, perform the pending live
ten-product and write/revert checks in a development store, complete an unassisted
setup check, and record the pending demo assets. Do not replace the synthetic
evaluation results with claims about production stores or SEO impact.
