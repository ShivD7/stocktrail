# Current limitations

These limits describe the current implementation. They are not promises of future
support.

## Storefront and detection scope

- Rendered checks target Dawn-compatible product forms and semantic controls.
- Each run observes one locale, market, CLI host, network path, and time window.
- The supported product shape is ordinary physical variants; subscriptions,
  bundles, selling plans, custom configurators, and unusual product forms can be
  inconclusive.
- Public Ajax and HTML targets must be derivable from the fresh Admin Online Store
  URL. Redirects are rejected rather than followed.
- JSON-LD is parsed from inline script blocks. External structured-data sources and
  JavaScript-generated markup are not evaluated by the non-browser collector.
- Variant matching prefers exact identifiers and deliberately returns
  `inconclusive` for ambiguous or conflicting evidence.
- ST-001 through ST-003 cover availability contradictions only. They do not prove
  correct price, delivery promise, market availability, checkout success, search
  indexing, ranking, or sales impact.

## Browser and cart scope

- A normal browser scan infers shopper availability from the exact selected variant
  and one visible add control; it does not submit the cart.
- Cart submission requires `--cart-add`, an initially empty cart, an exact response,
  and cleanup verification. Failure to prove cleanup is inconclusive.
- Checkout, accounts, orders, payments, third-party requests, WebSockets,
  screenshots, traces, videos, downloads, and persistent browser state are blocked.
- Browser runs are sequential per product/variant and can be slower than raw HTTP
  collection.

## Score and proposal scope

- Inventory Search Readiness is a deterministic diagnostic, not an SEO ranking or
  revenue forecast. An incomplete component makes the total score inconclusive.
- Proposal generation does not use a language model and does not invent copy.
- Supported changes are limited to removing a complete standalone transient
  inventory claim or copying existing content into an empty SEO field.
- StockTrail does not edit themes, inventory, variants, prices, handles, product
  status, publications, tags, metafields, or checkout behavior.
- Reverts are new proposals requiring independent review; they are not automatic
  rollback commands.
- An uncertain mutation response requires reconciliation. The mutation is not
  automatically retried.

## Runtime and operations

- Node.js 22.13 or newer is required; Node 24 is the documented development choice.
- Token mode is implemented. OAuth and a hosted callback are not.
- Schedules require an external launcher such as Task Scheduler or cron. StockTrail
  does not install a daemon or webhook relay.
- Graceful cancellation releases a schedule claim. A hard process kill can leave an
  active marker temporarily, but a later invocation can atomically reclaim it after
  six hours. This fixed threshold assumes legitimate runs finish sooner; a scan that
  truly remains active for six hours could be treated as abandoned.
- The dashboard is a loopback, single-machine application with no user account or
  remote-access authentication.
- Retention is manual. `delete-data` removes known current data, not external backups
  or copies.
- The package remains private and unpublished. Use repository scripts or `npm link`;
  do not assume `npx stocktrail` resolves to this code from the public registry.

## Validation status

The checked-in evaluation is synthetic:

- 24 curated rule cases, eight per rule.
- 13 adversarial proposal cases.
- The documented precision and rejection rates apply only to those fixtures.

The repository contains a Windows/Ubuntu CI workflow and a packed-install smoke
test. A workflow file existing is not evidence that a remote run passed.

The following remain release-validation activities and must not be presented as
completed until their actual results are recorded:

- live ten-product duration and Admin-request measurement;
- controlled Shopify write, reconciliation, verification, and revert;
- unassisted clean-machine setup;
- real development-store broken-to-fixed demonstration;
- cross-machine dashboard and browser verification beyond the CI matrix;
- final screenshots and demo recording.

See [Phase 6 evaluation](phase-6-evaluation.md) for reproducible synthetic results
and [Release checklist](release-checklist.md) for the pending validation gates.
