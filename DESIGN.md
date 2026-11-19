# DESIGN.md — StockTrail

## Product overview

StockTrail is an inventory reconciliation and SEO management tool for Shopify merchants.

It compares inventory information from Shopify Admin GraphQL with storefront observations gathered through Ajax, JSON-LD, and Playwright to identify product and variant availability inconsistencies.

It also provides rule-based SEO recommendations that merchants can review and approve before applying updates.

## Design philosophy

- **Actionable insights:** Every important issue should have a clear explanation and next action.
- **Trust before automation:** Merchants must understand proposed changes before approving them.
- **Data clarity:** Present complex inventory comparisons in a readable, structured way.
- **Operational efficiency:** Prioritize scanning, investigating, and resolving issues.
- **Calm and professional:** Make serious inventory problems visible without creating unnecessary alarm.

## Visual identity

**Style:** Premium B2B SaaS dashboard with a clean commerce-focused aesthetic.

**Personality:** Reliable, efficient, modern, analytical.

**Color palette:**
- Background: `#F8FAFC`
- Surface: `#FFFFFF`
- Secondary surface: `#F1F5F9`
- Primary text: `#0F172A`
- Secondary text: `#64748B`
- Borders: `#E2E8F0`
- Brand: `#4F46E5`
- Brand hover: `#4338CA`
- Success: `#059669`
- Warning: `#D97706`
- Critical: `#DC2626`
- Informational: `#0284C7`

Use light mode as the default. Dark mode is optional.

Avoid copying Shopify's interface exactly. StockTrail should have its own identity while feeling familiar to merchants.

## Typography

- UI font: Inter or Geist
- Monospace: JetBrains Mono for IDs and technical values
- Base size: 14px
- Page titles: 26–30px
- Section headings: 16–20px
- Table content: 13–14px
- Metadata: 12–13px

Prioritize clear number formatting and readable table labels.

## Application layout

Use a persistent sidebar and a compact top navigation bar.

Primary navigation:
- Overview
- Inventory Issues
- Products
- SEO Recommendations
- Activity History
- Settings

### Overview dashboard

The dashboard should immediately answer:

1. Are there inventory inconsistencies?
2. Which issues need attention?
3. What SEO changes are awaiting approval?
4. What happened during the latest scan?

Include:
- Summary metrics
- Latest reconciliation status
- Issue severity distribution
- Recently detected inconsistencies
- Pending merchant approvals
- Recent activity

Use restrained metric cards and meaningful tables.

Avoid charts that don't help merchants make decisions.

### Inventory issues page

Use a searchable, filterable table containing:
- Product
- Variant
- Shopify Admin availability
- Storefront availability
- Issue type
- Severity
- Last checked
- Action

Allow sorting by severity and detection time.

Use concise, consistent status labels.

### Issue detail view

Each issue should explain:
- What the inconsistency is
- What Shopify Admin reports
- What storefront observation reports
- Which variant is affected
- When each observation was collected
- Which source produced the observation
- What the merchant should investigate

Use a side-by-side comparison for Admin versus Storefront data.

Do not imply that one source is always correct.

### SEO recommendations

Display:
- Product
- Current title and metadata
- Proposed changes
- Reason for recommendation
- Approval status
- Last updated

Provide a readable before-and-after diff.

Merchant approval is required before updates are applied through Shopify GraphQL.

Use clear actions:
- Approve
- Reject
- Review Details

Use confirmation for consequential changes.

### Activity history

Provide an audit-friendly chronological view of scans, detected issues, recommendations, approvals, and applied updates.

Only show events actually recorded by the application.

## Component guidelines

- Cards: Subtle borders, minimal shadows
- Radius: 8–10px
- Tables: Primary tool for operational data
- Buttons: Strong primary action, quieter secondary actions
- Status badges: Muted fills with readable labels
- Drawers: Useful for reviewing records without losing table context
- Dialogs: Reserved for confirmation and high-impact actions
- Charts: Only when they provide actionable information

Avoid stacking cards inside cards.

## Interaction design

- Filters should be easy to combine and clear.
- Preserve table filters when opening and closing issue details.
- Support bulk selection only for safe, well-defined actions.
- Make background scan status visible where available.
- Never show a successful update before the server confirms it.
- Explain API and scan failures clearly.
- Show timestamps with timezone context.

## Data presentation

Inventory and availability data must be precise.

Differentiate:
- Missing observation
- Available
- Unavailable
- Inconsistent
- Unknown
- Scan failure

Do not treat missing data as unavailable stock.

Use tabular numeric alignment for quantities and metrics.

## Responsive design

Desktop: Full sidebar and data tables.

Tablet: Collapsible sidebar and horizontally scrollable tables.

Mobile: Prioritize issue summaries, detail views, and approvals. Replace complex tables with structured rows where necessary.

## Accessibility

- WCAG AA contrast
- Keyboard-accessible tables and actions
- Readable status descriptions
- Focus management in dialogs and drawers
- No color-only status communication
- Reduced-motion support

## Implementation guidance

Preserve the TypeScript, React, SQLite, Shopify GraphQL, and Playwright architecture.

Create reusable components for:
- Metric cards
- Inventory tables
- Status badges
- Issue detail drawers
- Product information
- Before-and-after SEO diffs
- Approval confirmations
- Scan status

Keep presentation separate from inventory reconciliation logic.

Use centralized design tokens and consistent spacing.

Do not introduce new Shopify mutations or automated operations without explicit product requirements.

## Design acceptance criteria

StockTrail should feel like software a real Shopify merchant could trust with operational decisions.

Users should immediately identify important inventory issues, understand conflicting observations, and confidently review proposed SEO changes.

The interface must prioritize accuracy, clarity, and merchant control.
