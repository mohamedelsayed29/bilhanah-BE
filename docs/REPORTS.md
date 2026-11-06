# Restaurant reports

`GET /v1/reports` and `GET /v1/reports/export?format=pdf|csv|html` require **both**
`analytics.view` and `analytics.financial`. Owners and managers have these by default.
Restaurant and fixed-branch scope are resolved fresh for each request. Foreign
branch, category and product ids are refused, even when the period is empty.

## Query

Required: `from`, `to` as real YYYY-MM-DD dates, inclusive, maximum 366 days.
Optional: `branchId`, `categoryId`, `productId`, `status`, `paymentMethod`
(`CASH`, `CARD`, `WALLET`, `OTHER`, `UNPAID`), `language=ar|en`,
`type=overview|sales|orders|products|categories|branches|payments`,
`page=1`, `pageSize=20` (maximum 100), `sort=net|gross|units|orders|name|date`,
`direction=asc|desc`. Orders use stable newest-business-day/number/id ordering.
Daily, trailing seven days, calendar month, calendar quarter and custom dates are
offered in the dashboard. Calendar boundaries use the restaurant timezone.

The response contains summary metrics, daily series (including zero days), branch,
category and payment aggregates, top ten products, paginated detail rows, total
matching rows and tenant-scoped filter options. Monetary values are **piastres**.
Percentages are 0-100; average and contribution are included on each row.
Export ignores pagination and includes every matching detail row. Choose the
Orders type for the full order dataset, Products for all sold product rows, etc.
CSV includes a UTF-8 BOM, quoted cells and formula-safe text. It is not a database
backup and intentionally does not include customer contact information.

## Interactive overview

`GET /v1/reports/overview` accepts the same validated filters plus the required
`period=day|month|year`, with the same financial permissions and tenant/branch
scope. Day requires `from=to` and groups actual `placed_at` instants into hourly
buckets, using PostgreSQL's local-midnight boundaries and `date_bin`; empty hours
are included. Today's series stops at the current hour. DST transition days may
contain 23 or 25 hours. Monthly/yearly responses retain the daily `business_day`
series from the reporting service and its existing calculation rules.

The dashboard's Day/Month/Year selector displays today by hour, the current month
by day, or the current year by month. Yearly aggregation retains every daily row
for the hover/keyboard daily breakdown. The line shows net sales; bars show order
counts. Both share the active time bucket, support touch and arrow keys, and have
screen-reader data tables. These are overview periods, separate from the detailed
report's date range; all other selected report filters apply. Exports continue to
use the detailed report filters. The overview automatically refreshes each minute.

## Accounting rules and current model limits

- Cohort reporting: orders belong to their persisted `business_day`, computed in
  the restaurant timezone when placed. Later status changes and recorded reversals
  update that cohort; this is not a cash-shift movement-by-transaction-date report.
- Gross sales = historical order-line unit price × quantity, excluding rejected
  and cancelled orders and cancelled kitchen lines. Both rejected and cancelled
  orders count under the labelled "Cancelled / rejected" metric.
- Net sales = eligible gross less recorded approved cash payment reversals.
  Reversals are capped at each order's subtotal and allocated proportionally by
  each line's original value. A cancelled order contributes zero gross/net, so
  its reversal is never deducted again. Repeated reversal cycles are capped.
- The "Recorded cash refunds" metric includes recorded reversals on cancelled
  orders too; it is a separate disclosure, **not** a second subtraction from net.
- Quantities exclude cancelled orders/lines. Order counts are distinct orders,
  including a cancelled order in a filtered category/product cohort. Pending means
  PLACED/ACCEPTED/PREPARING/READY. Refunded orders means an approved recorded reversal
  exists. Average = net / (orders excluding cancelled/rejected), including pending.
- Filtering by category/product restricts amounts and quantities to matching lines,
  while counting each matching order once. Contributions use the same filtered net
  total. Product counts are distinct products represented in the cohort.
- Names and prices come from immutable order snapshots. Category membership comes
  from the current menu; deleted products go under Uncategorised. Moving a product
  between categories can therefore change its historical category attribution.
- There is **no discount ledger** and **no comprehensive card/wallet refund ledger**
  in the existing application. Discounts are explicitly zero/not tracked, and only
  recorded cash reversals are reported. A reversal without an open drawer may not
  have a cash ledger entry. These reports cannot claim all payment-method refunds.
  Supporting them requires a future authoritative discount/refund model; neither
  browser nor reporting API fabricates those amounts.
- The platform's order prices are Egyptian piastres. Reports use the cash settings'
  EGP currency, defaulting to EGP. A non-EGP cash setting is refused rather than
  relabelling historical Egyptian amounts or inventing exchange rates.
- Proportional allocations are computed with PostgreSQL numeric arithmetic and
  rounded to whole piastres at aggregation boundaries; category sums can differ
  from the restaurant total by rounding (at most a piastre per allocation group).

## Generation, deployment and limits

Reports use parameterised SQL and a repeatable-read transaction so all aggregates
within a response share one snapshot. An index covers restaurant/business day/
branch; each statement has a 20-second timeout. PDF/CSV/preview use the same service
as the dashboard, taking a fresh snapshot with the selected filters at generation
time. Live activity since the page loaded can change figures; generation timestamps
are printed in exports. Refresh the dashboard to compare the latest snapshot.

One export at a time per API process, a per-IP rate limit, and 30-second database
transaction timeout protect the live API. CSV supports 50,000 orders per export;
PDF/preview 5,000 detail rows. Exceeding a limit returns REPORT_TOO_LARGE without
silently truncating. Split by branch or dates for larger cohorts. HTML previews
and PDFs share one branded template. Headers repeat on continued tables; PDF
footers include page/total pages and generation date. Browser printing is bounded
to 45 seconds; the browser closes on success or failure.

PDF requires Chrome/Chromium. The runtime Docker image installs Chromium;
`REPORT_CHROMIUM_PATH` can override detection for other hosts. Local Windows uses
installed Chrome. Official logo and existing IBM Plex Sans Arabic font subsets
are bundled under `assets/reports` with their font license. Restaurant logos are
read through StorageService, not arbitrary HTTP URLs. All content is escaped;
Chromium blocks network requests, and previews have a restrictive CSP. No OpenAI
or external PDF service receives restaurant data.

Visual identity follows the rebuilt dashboard and website: Chili Coral #F45164,
Mango #FFC857, Deep Aubergine #35172F and Warm Cream #FFF3E7. The report cover
and repeated side ornaments reuse the exact SVG paths from the marketing hero;
ornaments mirror for Arabic. Plus Jakarta Sans is bundled for English headings.
Page ornaments embed the SVG as an image so Chromium repeats it correctly on
continued pages. A dedicated gutter keeps decoration clear of report data.

Dashboard route: `/reports` (owners), `/manager/reports` (managers). Exports show
progress, error and success states. PDF hover/focus animation lasts 1.25 seconds,
one iteration per entry; prefers-reduced-motion disables it.

## Verification

`npm run typecheck`; `npm run test:e2e -- test/reports.e2e-spec.ts`.
In the restaurant dashboard: `npx playwright test tests/reports.spec.ts` after
`npm run seed:demo` in the backend. Tests cover isolation, permissions, local-day
cohorts, leap dates/range limits, cancelled orders, reversals, pagination-independent
CSV, formula injection, PDF generation, Arabic/English, preview and finite motion.
