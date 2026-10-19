# Demo script

**Status:** pending recording. No screenshot, video, live-store metric, or Shopify
write result is asserted by this document.

## Recording prerequisites

- Use a disposable Shopify development store and a Dawn-compatible theme.
- Prepare one ordinary product with an intentionally controlled availability
  contradiction and a corrected state.
- Import and monitor that product before recording.
- Confirm `doctor --live`, the intended token scopes, and browser availability.
- Keep cart submission off unless the development store is empty and the probe has
  been explicitly approved.
- Close notifications and hide the token prompt, store identity, GIDs, SKUs, local
  paths, and any customer or cart data.
- Run the full release checklist before recording. Do not substitute synthetic
  fixture results for live validation.

## 60–90 second storyboard

Target duration: about 80 seconds. Capture actual output; do not add numbers or
outcomes that were not observed during the recording session.

| Time | Picture | Narration |
| --- | --- | --- |
| 0–8s | Repository title and a clean terminal; briefly show `stocktrail --help`. | “StockTrail is a local Shopify inventory-truth tool: Admin facts, storefront behavior, and search data in one evidence trail.” |
| 8–18s | Run `doctor --live` with private identifiers cropped. | “The token stays in the operating-system credential store. This check verifies capabilities without changing Shopify.” |
| 18–28s | Show the dashboard Products view with one already monitored development-store product. | “The catalog is imported locally, and only selected products are scanned.” |
| 28–43s | Trigger a browser-backed scan from the dashboard or run `scan --browser --product-id <gid>` off-camera, then return to the UI. | “A fresh scan compares Admin availability, public Ajax data, JSON-LD, and a locked-down Dawn browser observation.” |
| 43–58s | Open the incident detail and show the three evidence perspectives and actual rule result. | “Exact variant matching prevents guesses. Missing or ambiguous evidence stays inconclusive; a verified contradiction becomes an incident.” |
| 58–68s | Show the stored test result before the controlled fix. | “The incident creates a data-driven regression assertion, so the same condition can be checked again.” |
| 68–80s | Cut to the corrected development-store state and show the fresh rerun result and resolved incident. | “After the controlled fix, fresh evidence reruns the same assertion and updates the incident lifecycle.” |
| 80–88s | End on Overview with the current readiness state and local-only label. | “Evidence, scores, proposals, and history stay on this machine by default.” |

If the controlled case does not produce the expected result, record the real
inconclusive or failure state and fix the product or adapter before attempting the
storyboard again. Never fabricate a fail-to-pass sequence in editing.

## Commands for preparation

Replace placeholders locally; do not paste real identifiers into this file.

```powershell
npm install
npx playwright install chromium
npm run dev -- doctor --live
npm run dev -- import
npm run dev -- monitor candidates
npm run dev -- monitor add --product-id <product-gid>
npm run dev -- scan --browser --product-id <product-gid>
npm run dev -- test --browser
npm run dev -- dashboard --no-open
```

Use `scan --demo` only as clearly labeled offline backup footage. It proves CLI
packaging and synthetic diagnostic behavior, not live storefront collection.

## Screenshot checklist

All assets are pending capture. Prefer synthetic or carefully redacted development-
store content. Review every image at full resolution before adding it to the
repository.

- [ ] Overview: open/resolved counts, monitored count, latest scan, and local-only
  label; no store domain or private title unless intentionally anonymized.
- [ ] Products: monitored status and readiness state with identifiers cropped.
- [ ] Incident detail: Admin, storefront, and search evidence plus the actual rule
  result; remove raw private content not needed for the story.
- [ ] Regression rerun: before-fix result and corrected result from the same stored
  assertion.
- [ ] Proposal review: deterministic field diff and warning state; no live approval
  token or unredacted merchant copy.
- [ ] Connection: credential-storage state and aggregate local-data counts; hide the
  shop domain.
- [ ] CLI offline demo: retain the visible “synthetic fixtures” label.
- [ ] Narrow viewport and keyboard-focus state for dashboard accessibility evidence.

## Final recording checks

- [ ] Duration is between 60 and 90 seconds.
- [ ] Every claimed result appears in the recording.
- [ ] Synthetic footage is visibly labeled synthetic.
- [ ] No token entry, credentials, headers, request IDs, customer data, notifications,
  real filesystem paths, or private store identity is visible.
- [ ] No checkout is attempted; any cart probe is explicitly authorized and cleaned.
- [ ] Captions and narration call the readiness score a diagnostic, not an SEO claim.
- [ ] The committed video/screenshots contain no embedded private metadata.
