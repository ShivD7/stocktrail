---
target: StockTrail dashboard
total_score: 23
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\Dev\\Documents\\ChatGPT\\Shopify\\stocktrail-phase6\\apps\\dashboard\\client\\src\\App.tsx"
target_fingerprint: "sha256:0ba58ad275a34d8cd67cd033c40c1e8652f34bec9f3f71abee89fe79dfc07776"
target_path: "C:\\Users\\Dev\\Documents\\ChatGPT\\Shopify\\stocktrail-phase6\\apps\\dashboard\\client\\src\\App.tsx"
timestamp: 2026-11-19T19-20-57Z
slug: apps-dashboard-client-src-app-tsx
---
Method: dual-agent (A: /root/design_review; B: /root/ui_evidence)

# StockTrail visual design review — 2026-11-19

Authority: DESIGN.md. Target: apps/dashboard/client/src/App.tsx and its dashboard views. Mode: Operate. Existing React/Vite architecture, hash routes, API contracts, domain models, and backend integrations are preserved.

## Baseline assessment

The independent source review scored the original interface 23/40. The workflow was specific to StockTrail, but its forest/cream palette, large Georgia headings, repeated eyebrow labels, and generous metric cards contradicted the supplied operational dashboard specification.

| Heuristic | Baseline /4 | Main gap |
|---|---:|---|
| Visibility of system status | 3 | No explicit timestamp timezone |
| Match with the real world | 2 | Diagnostic jargon and privileged Admin labeling |
| User control and freedom | 3 | Filters lost after inspecting an issue |
| Consistency and standards | 2 | Palette, typography, and component scale drift |
| Error prevention | 3 | Existing confirmation and server guards were strong |
| Recognition rather than recall | 2 | Generic source summaries and unexplained readiness |
| Flexibility and efficiency | 2 | Missing severity/time sorting |
| Aesthetic and minimalist design | 2 | Oversized headings and redundant labels |
| Error recovery | 2 | Uneven retry affordances |
| Help and documentation | 2 | Some implementation terminology |
| Total | 23/40 | Acceptable; significant refinement needed |

## Strengths preserved

Merchant approval remains explicit. Proposal content remains inert text. The existing focus trap, warning acknowledgment, duplicate-submit protection, server-confirmed feedback, and revert workflow remain intact. Observed and inconclusive evidence remain distinct; missing scores never become zero.

## Priority findings and implemented refinements

- P1 visual-system drift: replaced the palette with the specified slate/white/indigo tokens, self-hosted Inter and JetBrains Mono, 26–28px page titles, 13–14px operational text, 12px metadata, tabular numerals, 9px panels, and restrained surfaces.
- P1 triage inefficiency: retained filters in the mounted application shell across detail navigation; added combined severity/status/search filters, detection-time sorting, clear actions, explicit select labels, and a read retry.
- P1 source framing: renamed Shopify truth to Shopify Admin, surfaced the existing last-evaluated timestamp and variant ID, and explained that inconclusive collection does not imply unavailable stock. Source-specific values unavailable through the current API remain accessible through saved evidence links.
- P2 hierarchy and navigation: added a compact top bar and keyboard-operable collapsible navigation, actionable inventory metrics, recent findings, severity counts, and latest ready proposals from existing read endpoints. Tablet grids reflow; mobile tables become labeled rows.
- P2 review clarity: added side-by-side current/proposed text with an expandable semantic diff; kept consequential confirmations and made the added top bar inert during confirmation. Unknown verified scores use neutral styling. Keyed detail views prevent prior-record state surviving an ID change.
- P2 timestamps and recovery: centralized timezone-aware date formatting and added connection/list retry actions.

## Persona and cognitive-load checks

Alex, the daily operator, can prioritize by severity or detection time and return to the same filtered list. Sam, the keyboard user, retains skip navigation, labeled controls, visible focus, Escape handling, and protected confirmation focus. Casey, the mobile merchant, gets readable structured issue rows, full-width sorting, touch targets, and wrapping product titles. Five informational readiness components remain; they are not competing actions.

The investigation remains the highest-friction moment because the API returns source collection outcomes rather than normalized source availability values. Saved evidence provides the existing investigation path. Approval still requires deliberate review and confirmation.

## Remaining limitations

The current API has no unified activity feed, per-source observation timestamps, or normalized availability values for the list/comparison. No new backend features, routes, fabricated history, or inferred stock values were introduced. The overview approval queue is explicitly the latest ready proposal per product, not a complete historical proposal index. Visual/browser verification uses synthetic fixtures, not a live merchant store. Filters survive in-app detail navigation; a full reload resets them.

## Detector and verification

The deterministic detector ran once: zero errors and two overused-font warnings at styles.css lines 1 and 4. Both refer to Inter and are intentional exceptions because DESIGN.md requires Inter or Geist. No other detector findings were reported.

The full suite passed 195/195 tests, including browser regressions for keyboard/dialog behavior, inert previews, reduced motion, overflow checks across 320/375/768/1024/1440 widths, mobile navigation, filter preservation, severity sorting, and oldest/newest detection sorting. Production build and TypeScript checks pass. Fonts and their SIL licenses ship locally.

Questions skipped: the user supplied the design authority and authorized implementation; remaining limitations require separate backend/product scope.
