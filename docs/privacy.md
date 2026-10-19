# Privacy and local data

StockTrail is local-first, not data-free. It intentionally keeps credentials and
merchant evidence on the machine running the CLI. Anyone operating it should treat
the StockTrail data directory as private merchant data.

## What is stored

The default data directory is `.stocktrail` beneath the current working directory.
`STOCKTRAIL_HOME` can point to another absolute location.

| Location | Contents |
| --- | --- |
| `config.json` | Configuration version and the normalized `*.myshopify.com` domain. No token. |
| `stocktrail.sqlite` plus SQLite sidecars | Catalog fields, monitoring selection, import provenance, evidence indexes, rule results, incidents, tests, readiness scores, proposal lifecycle/audit metadata, and scan schedules. |
| `artifacts/scans/<run-id>` | Admin evidence, fetched public Ajax JSON, fetched product HTML, normalized JSON-LD, optional browser observations, and the bundle manifest. |
| `artifacts/proposals` | Integrity-indexed proposal, before/candidate, diff, mutation-summary, and reconciliation artifacts. |
| `reports` | Offline demo or standalone evidence reports. |
| OS credential store | The Admin API token, keyed by configured shop domain. |

Catalog fields and evidence can include titles, descriptions, handles, SKUs,
inventory state, public product markup, and proposal content. SQLite and artifacts
are not application-level encrypted. Operating-system account security, disk
encryption, backups, and access to `STOCKTRAIL_HOME` remain user responsibilities.

The repository ignores `.stocktrail`, environment files, build output, and local
dependencies. Never copy real credentials, private evidence, terminal output with
store details, or screenshots containing merchant data into source control.

## Credentials

- `connect` reads a token from an interactive no-echo terminal prompt.
- Tokens are stored through Windows Credential Manager, macOS Keychain, or a Linux
  Secret Service provider.
- Linux does not silently fall back to a transient in-memory kernel keyring.
- Configuration, SQLite, evidence artifacts, fixtures, and normal diagnostic output
  do not contain the token.
- `logout` removes the stored token. `delete-data` removes it before deleting local
  StockTrail files, so a keyring failure does not orphan an unknown credential.

Read workflows require product-read capability. Product-content application also
requires `write_products` and explicit proposal approval.

## Network activity

| Action | Network behavior |
| --- | --- |
| `scan --demo` | Offline synthetic flow; no Shopify or storefront request. |
| `doctor` | Local checks only. `doctor --live` verifies the saved Shopify token. |
| `import`, Admin scans | Authenticated Shopify Admin GraphQL requests. |
| Ajax/HTML scan | Cookieless public requests to targets derived from fresh Admin evidence. Redirects are not followed. |
| Browser scan | Fresh local Chromium contexts restricted to the validated storefront origin. |
| `apply` | One explicitly approved Shopify `productUpdate` attempt, followed by reconciliation and verification. |
| Dashboard | Loopback HTTP on `127.0.0.1`; no hosted StockTrail service. |

Public fetches resolve and reject private or reserved addresses, pin the validated
address, cap time and body size, and do not forward the Admin token. Browser runs
block third-party traffic, WebSockets, checkout/account/order/payment routes,
downloads, persistent state, screenshots, traces, and video.

The ordinary browser scan observes controls only. `--cart-add` is a separate,
explicit authorization to add one variant to an initially empty development-store
cart and attempt verified cleanup. It never authorizes checkout.

## Output and error handling

Import, scan, performance, schedule, and test summaries favor counts, statuses, and
reason codes. They avoid product content, raw response bodies, headers, request IDs,
query cost, credential values, and absolute artifact paths. Some explicitly invoked
local review views—such as proposal diffs and dashboard detail pages—display private
catalog or evidence content because review is their purpose.

Adapters produce sanitized errors, and the CLI applies centralized redaction for
common token, secret, authorization-header, bearer-token, and URL-credential forms.
Redaction is defense in depth, not permission to log raw responses.

Stored HTML is served by the dashboard as `text/plain`, never executed. API and
evidence responses use `no-store`, restrictive security headers, exact Host checks,
and matching Origin checks for mutations. There is no CORS grant. The dashboard has
no user login and should remain a same-machine tool.

## Integrity and deletion

Evidence and proposal artifacts are written to private staging locations, hashed,
validated, and published atomically. SQLite indexes their relative paths, sizes,
and SHA-256 values. Consumers verify indexed artifacts before using them for
diagnostics or proposals.

Retention is currently manual. To erase known StockTrail data and the saved token:

```powershell
npm run dev -- delete-data --confirm your-store.myshopify.com
```

The confirmation must exactly match configuration. The command refuses filesystem
roots, the home directory, symbolic links, unexpected entry types, and unrelated
files. Review backups separately: StockTrail cannot erase copies made by backup,
sync, terminal-capture, or screen-recording software.

## Fixture and recording policy

- Automated fixtures must be synthetic and use non-routable/example identities.
- Synthetic evaluation measures the curated corpus only; it is not live-store
  accuracy, merchant impact, or SEO evidence.
- Record the demo only against a controlled development store.
- Hide the token prompt, crop unrelated windows, and remove store names, domains,
  product IDs, SKUs, customer/cart details, filesystem paths, and notifications.
- Do not commit live evidence bundles or real screenshots.
