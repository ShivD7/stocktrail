# StockTrail local diagnostic CLI

StockTrail runs on the user's computer. It is not an embedded Shopify app.

- Use `npm run dev -- --help`, `npm run typecheck`, and `npm test`.
- Keep command handling in `apps/cli`, orchestration in `packages/agent`, and pure rules in `packages/detector`.
- Do not restore App Bridge, hosted app routes, Shopify session storage, or `shopify app dev` as runtime requirements.
- Live Shopify collection is not implemented yet. Keep fixture output clearly labeled as demo data.
- Future integrations must be read-only by default and must not log tokens or commit credentials/evidence.
- Consult current official Shopify documentation and the Shopify AI Toolkit for future Shopify API/platform work. Tooling belongs in the agent host, not runtime dependencies.
- Add the local dashboard, database, and additional packages only when their features are implemented.
