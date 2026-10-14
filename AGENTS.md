# StockTrail contributor guide

## Purpose

StockTrail is a local-first Shopify inventory truth and discoverability tool. It compares Admin inventory intent with the live storefront and machine-readable product data, records evidence, and turns contradictions into repeatable tests. It is a CLI and local dashboard, not an embedded Shopify app.

## Key locations

- `apps/cli/src`: command parsing and terminal output.
- `apps/dashboard`: local React dashboard when implemented.
- `packages/agent/src`: workflow orchestration, configuration, and credentials.
- `packages/shopify/src`: Shopify Admin, Ajax, HTML, and browser adapters.
- `packages/detector/src`: pure normalization and deterministic rules.
- `packages/shared`, `database`, `scorer`, `proposals`, and `test-runner`: add only with working features.
- `tests`: focused unit and CLI integration tests.
- `docs`: architecture, execution, privacy, and migration guidance.

## Commands

- `npm run dev -- --help` builds and runs the local CLI.
- `npm run dev -- <command>` runs a CLI command during development.
- `npm test` builds and runs the full test suite.
- `npm run build` creates the production TypeScript build.
- `npm run typecheck` checks types without emitting files.

## Working rules

- Keep command handling in `apps/cli`, orchestration in `packages/agent`, Shopify-specific code in `packages/shopify`, and pure rules in `packages/detector`.
- Do not add App Bridge, hosted app routes, Shopify session storage, or `shopify app dev` as runtime requirements.
- Keep Shopify access read-only by default. Require explicit approval for any supported write.
- Validate current Shopify API fields, scopes, and versions against official documentation or the Shopify AI Toolkit before implementation.
- Keep fixture and demo output clearly labeled; never present synthetic evidence as a live-store result.
- Reuse existing components, styles, domain types, and utilities before introducing new abstractions.
- Add a dependency or package only when the implemented feature needs it.
- Never place credentials, tokens, private store data, customer data, request headers, or raw private evidence in source, fixtures, logs, screenshots, or commits.
- Redact sensitive values in errors and diagnostics. Store secrets only through the credential-store abstraction.
- Prefer deterministic rules with explicit `inconclusive` results over guessed conclusions.
- Preserve keyboard accessibility, visible focus behavior, semantic controls, and responsive behavior when changing the dashboard.
- Keep narrow and wide layouts usable; do not make critical actions hover-only or pointer-only.

## Definition of done

- Add or update focused tests for the changed behavior and run them directly where practical.
- Run the full suite with `npm test`.
- Run `npm run typecheck` and produce a clean production build with `npm run build`.
- For UI work, check the affected flow in a browser with keyboard navigation and narrow and wide viewports.
- Review the final diff for unrelated changes, generated files, secrets, private data, and misleading demo claims.
- Report what changed, verification performed, and a short risk or limitation summary.
