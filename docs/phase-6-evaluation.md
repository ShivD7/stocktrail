# Phase 6 resilience and evaluation

This report records reproducible Phase 6 evidence. The fixture sets are synthetic
and contain no merchant, customer, credential, request-header, or private store data.
They measure the implemented rules against curated cases; they are not a claim of
real-world SEO ranking impact or broad statistical accuracy.

## Reproduce

```powershell
npm install
npm run build
node dist/packages/evaluation/src/cli.js fixtures/evaluation/rule-cases.json
node dist/packages/evaluation/src/proposal-cli.js fixtures/evaluation/unsafe-proposal-cases.json
npm run typecheck
npm test
npm run test:pack
```

The CI workflow repeats typecheck, tests, production build, and the packed-CLI
install smoke test on Windows and Ubuntu with Node 22.13.1.

## Rule corpus results

The corpus contains 24 labeled normalized-evidence cases: eight for each of
ST-001, ST-002, and ST-003.

| Metric | Result |
| --- | ---: |
| True positives | 5 |
| False positives | 0 |
| True negatives | 7 |
| False negatives | 0 |
| Inconclusive | 10 |
| Not applicable | 2 |
| Precision on labeled positive predictions | 100% |

All 24 actual results match their expected result. Per-rule precision is 100%
on this corpus. Inconclusive and not-applicable outcomes are intentionally not
forced into pass/fail labels.

## Proposal safety results

The adversarial proposal corpus contains 13 cases covering invented facts,
active content, unsafe or unbalanced HTML, transient stock claims, information
loss, missing attribution, score regression, artifact tampering, unsupported
fields, and duplicate edits. The production validator rejected all 13:

- Unsafe proposals accepted: **0**
- Unsafe proposal acceptance rate: **0%**

This evaluates deterministic validation. It does not authorize a Shopify write;
every valid proposal still requires a fresh stale check, exact approval, scope
verification, one mutation attempt, reconciliation, and a verification scan.

## Repeated-run resilience

- Incidents remain unique by product, variant, and rule.
- Repeated failures update `lastSeenAt` and the occurrence count.
- Passing evidence resolves an open incident; a later failure reopens it.
- Ignored incidents remain ignored.
- Scheduled runs atomically claim work, reject overlap, isolate product failures,
  and persist the next due time.
- Ctrl+C propagates cancellation to the active scan and releases the claim.
- Read-only Admin requests retry only bounded transient failures. Mutations remain
  single-attempt and use reconciliation for uncertain outcomes.

A hard process kill can leave a persisted active schedule marker. Graceful
cancellation is covered; automatic stale-claim recovery remains a known limitation.

## Privacy and local control

- The CLI applies centralized token/header/URL-credential redaction to uncaught
  error messages, with canary tests.
- `doctor --live` verifies capabilities without displaying the token, store name,
  response body, request ID, or query cost.
- `delete-data --confirm <shop>` validates exact targets before deleting known
  StockTrail files and the OS-stored token. Unexpected links/types abort before
  local data is removed.
- Evaluation and performance output is aggregate-only.

## Ten-product performance measurement

Run the following only after exactly ten active products are selected:

```powershell
npm run dev -- performance --live
```

The command records total duration, completed/failed product counts, and physical
Admin API requests including retry attempts. It performs browser diagnostics
sequentially with cart submission disabled and prints no product identifiers or
content. A real-store result is deliberately not committed because live validation
was deferred; capture the aggregate output during final release testing.

## Current limitations

- Dawn-compatible product forms only.
- One storefront locale and market per run.
- Ordinary physical variants only.
- Scheduled execution relies on Windows Task Scheduler, cron, or another local
  launcher invoking `schedule run`; StockTrail does not install a resident daemon.
- The GitHub matrix proves Ubuntu and Windows only after the workflow runs remotely.
- Live Shopify write, revert, ten-product performance, and unassisted setup checks
  remain release-validation activities.
