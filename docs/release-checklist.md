# Release checklist

This is the resume point for validating the v0.1.0 source release and deciding its
distribution. Checked implementation items mean the capability exists in the
repository; they do not replace a fresh verification run or live-store evidence.

## Current implementation summary

- [x] Secure token-mode connection and capability verification.
- [x] Idempotent SQLite catalog import and ten-product monitoring selection.
- [x] Admin, Ajax, HTML, JSON-LD, and Dawn browser evidence bundles.
- [x] Deterministic ST-001, ST-002, and ST-003 with inconclusive outcomes.
- [x] Persisted incidents, regression assertions, and readiness diagnostics.
- [x] Conservative content proposals, explicit approval, reconciliation, and revert
  proposals.
- [x] Loopback React dashboard over the same repository and artifacts as the CLI.
- [x] Externally invoked monitored-product schedules, bounded retry/cancellation,
  redaction, and guarded local-data deletion.
- [x] Synthetic rule/proposal evaluation and a Windows/Ubuntu CI definition.
- [ ] Live release validation and recording are complete.
- [ ] The package is public and published.

## Fresh local verification

Run from a clean working tree using a supported Node version:

```powershell
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run test:pack
node dist/packages/evaluation/src/cli.js fixtures/evaluation/rule-cases.json
node dist/packages/evaluation/src/proposal-cli.js fixtures/evaluation/unsafe-proposal-cases.json
```

- [ ] Typecheck passes.
- [ ] Full tests pass.
- [ ] Production server and dashboard builds pass.
- [ ] Packed CLI installs in a temporary consumer project; help and offline demo pass.
- [ ] Rule corpus reproduces the documented fixture-only result.
- [ ] All adversarial proposal fixtures remain rejected.
- [ ] Final `git diff --check` is clean.
- [ ] Final diff contains no unrelated generated files, credentials, private store
  data, customer data, real evidence, or misleading claims.

Record the date, commit, Node/npm versions, operating system, and command results in
the release notes or release PR. Do not put credentials or private catalog output in
that record.

## CI and clean installation

- [ ] Push the release candidate and confirm the actual GitHub Actions result on
  both `windows-latest` and `ubuntu-latest` with Node 22.13.1.
- [ ] Confirm Playwright Chromium installs and the browser tests execute in both jobs.
- [ ] Perform an unassisted setup from the README on a clean Windows account or
  machine.
- [ ] Perform or observe a clean Unix setup, including an available, unlocked Secret
  Service credential store.
- [ ] Confirm the packed artifact contains the CLI and dashboard assets required at
  runtime.
- [ ] Decide whether to keep the package private, publish it, or document local-only
  installation for this release. Do not advertise `npx stocktrail` until publishing
  is verified.

## Controlled live validation

Use only a disposable development store and anonymized products.

- [ ] `doctor --live` verifies the intended store and reports read/write capability
  without exposing the token or response details.
- [ ] Import is duplicate-safe across two runs and a limited import does not
  deactivate unseen products.
- [ ] Exactly ten active products can be monitored; an eleventh is rejected.
- [ ] A combined non-browser scan saves integrity-checked Admin, Ajax, HTML, JSON-LD,
  and bundle artifacts.
- [ ] A Dawn browser scan selects exact variants and produces honest observed or
  inconclusive results with cart submission disabled.
- [ ] The controlled broken case produces the expected actual incident and stored
  assertion; the corrected case resolves it on rerun.
- [ ] An explicitly authorized empty-cart probe succeeds or reports its real reason,
  and cleanup is verified. Checkout is never attempted.
- [ ] A valid proposal is reviewed; stale content is rejected.
- [ ] With a disposable product and explicit approval, apply performs no more than
  one write attempt and reconciliation records the actual outcome.
- [ ] A revert proposal is independently reviewed and its actual apply/verification
  result is recorded.
- [ ] `performance --live` runs with exactly ten products and its aggregate duration,
  completed/failed count, and physical Admin request count are recorded outside
  source if they reveal private operational context.
- [ ] Graceful Ctrl+C cancellation releases a scheduled-run claim.
- [ ] Simulate an abandoned schedule claim and confirm it remains protected before
  six hours but is atomically reclaimed at the six-hour boundary. Confirm the fixed
  threshold is acceptable for expected scan duration.
- [ ] `delete-data` is tested only after preserving any evidence needed for the demo;
  it removes known StockTrail data and the saved token while preserving unrelated
  files.

## Dashboard and accessibility review

- [ ] Start `dashboard --no-open`; confirm it binds only to `127.0.0.1`.
- [ ] Check Overview, Products, product detail, Incidents, incident detail, proposal
  review, and Connection with real local state.
- [ ] Verify import, monitor, scan, improve, rerun, proposal, and connection flows
  show loading, success, empty, and failure states where applicable.
- [ ] Navigate every affected flow by keyboard, including skip link and restored
  heading focus.
- [ ] Verify visible focus and semantic control names.
- [ ] Check narrow and wide viewports; ensure critical actions are not hover-only.
- [ ] Confirm HTML evidence is displayed as text and browser devtools show no CORS
  grant or cached evidence/API responses.

## Documentation and presentation

- [x] Architecture, privacy, limitations, demo script, release checklist, migration,
  execution plan, and synthetic evaluation documents are linked from the README.
- [ ] Verify every command in the README and demo script against `--help`.
- [ ] Record the 60–90 second storyboard in [Demo script](demo-script.md).
- [ ] Capture and privacy-review each pending screenshot in the demo checklist.
- [ ] Add actual asset links only after files exist and pass privacy review.
- [ ] Clearly label synthetic evaluation, live development-store validation, and any
  remaining untested path.
- [ ] Prepare release notes with known limitations and no SEO, revenue, or broad
  accuracy claims.

## Release decision

- [ ] Every release-blocking item above is complete or explicitly deferred with an
  owner, reason, and user-visible limitation.
- [ ] The final commit is tagged only after verification results and the published or
  local-installation path are known.
- [ ] No new feature work begins during the release buffer.

If work pauses, resume with the first unchecked item in **Fresh local verification**,
then proceed in order through CI, controlled live validation, dashboard review, and
presentation. The repository implementation is ahead of the unverified release
claims; preserve that distinction.
