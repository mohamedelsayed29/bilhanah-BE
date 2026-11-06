# Feedback and reviews

Diners rate their visit (and each dish) after ordering; restaurants read,
reply, follow up on unhappy diners, choose what is shown publicly, and see
how ratings move over time, per branch and per dish. Happy diners can be
invited to review the branch on Google.

Plan: `PLAN_FEATURES[plan].reviews` (ORDERS and ADVANCED by default; decided
in `plans.ts` only). Without it, owner routes answer 409 `REVIEWS_UNAVAILABLE`,
diners are not asked (eligibility `UNAVAILABLE`, PUT 409), nothing is shown
publicly (public page 404 `REVIEWS_NOT_PUBLIC`, no dish badges,
`PublicRestaurant.reviews: null`); data is kept.

Code: `src/modules/reviews/` (rules and maths in `reviews-rules.ts` / `reviews-math.ts`),
contracts in `packages/contracts/src/reviews.ts` (schemas, restaurant views) and
`review-display.ts` (zod-free: constants, display names and the types diners' pages use),
tables in migration `20261114000000_reviews`.

## Principles

- **Verified first.** A review tied to an order is proven by the order's tracking
  token: one review per order (unique `order_id`), marked *verified*. Unverified feedback (from a table
  QR or the menu, without an order) exists only if the owner allows it, is
  rate-limited, and is labelled as such everywhere (`verified: false`, `source: TABLE | MENU`).
- **The owner decides** what diners are asked, what is published, and when they
  are alerted (all in review settings).
- **Private by default.** A diner's phone number is collected only with explicit
  consent (`contactConsent`; withdrawing it forgets the number), is visible only to staff who
  follow diners up (`reviews.respond`, see Permissions), and is never public or in realtime events.
  Public reviews show a display name only ("Mona A.") or `null`, shown as "Guest" / "ضيف".
- **Honest.** Low ratings are never hidden from the owner (the inbox, stats and export count every
  review, published or not). Publishing rules apply equally to all ratings when the owner picks
  automatic publishing by threshold, and the public summary (average, count, distribution) is
  computed from **all published reviews**, so filtering cannot be used to fake an average unless
  the owner chooses moderation, which the public page states (`summary.policy`).

## Settings (per restaurant; defaults in brackets)

`GET /v1/reviews/settings` (reviews.view or reviews.settings), `PUT` (reviews.settings): any subset; audited (`reviews.settings`).

| Setting | Meaning |
| --- | --- |
| `enabled` [false] | Diners are asked for feedback. |
| `askAfter` [COMPLETED] | `READY` or `COMPLETED`: when the tracking page invites a review. |
| `allowUnverified` [false] | Feedback without an order (table QR / menu), rate-limited, labelled unverified. |
| `subRatings` [food, service] | Which extra 1–5 ratings to ask: `food`, `service`, `value`, `speed`, `cleanliness`, `atmosphere` (any subset). |
| `dishRatings` [true] | Ask a thumbs up/down (or 1–5, see `dishRatingScale` [THUMBS]) for each dish in the order. Thumbs travel and are stored as 5 (up) / 1 (down) (`DISH_THUMBS`). |
| `commentRequiredBelow` [3] | A comment is required when the overall rating is below this (0 = never). |
| `photos` [true] | Up to 3 photos per review (re-encoded to WebP, metadata stripped). |
| `tags` | Owner-editable quick chips `{ code, nameAr, nameEn, sentiment: POSITIVE/NEGATIVE }`, max 20 (defaults: delicious, fast, friendly staff, good value, clean / cold food, slow, wrong order, small portion, rude staff). Reviews keep tag codes; a removed tag keeps its code as its name. |
| `publishMode` [AUTO] | `AUTO`: reviews at or above `publishMinStars` are published automatically, others wait for moderation. `MANUAL`: everything waits. `NEVER`: nothing is public (the publish route answers 409 `REVIEW_PUBLISHING_OFF`, photos stay private, the public page is 404). |
| `publishMinStars` [1] | For AUTO; 1 means everything is published at once. |
| `showOnMenu` [false] | Show the dish rating badges and the reviews page on the public menu. |
| `menuMinCount` [3] | A dish shows its rating only after this many dish ratings. |
| `googlePrompt` [true] + `googleMinStars` [4] | After a review at or above the threshold, invite the diner to also review the branch on Google (needs the branch's `googleReviewUrl`). The invitation is shown whatever the rating would be on Google; Bilhanah never gates or edits it. |
| `alertBelowStars` [3] | Reviews below this alert the restaurant (0 or 1: never): realtime on the dashboard (`lowRating: true`), an email to the owner and to staff with `reviews.respond` at that branch, and an OPEN follow-up. |
| `editWindowHours` [24] | How long a diner may edit their review (0–720; fixed per review when it is written). |
| `displayName` [FIRST_NAME_INITIAL] | `FIRST_NAME_INITIAL`, `FIRST_NAME`, or `ANONYMOUS` on public reviews. |

Per-branch: `branches.google_review_url` (optional http(s) URL), edited with the branch
(`PATCH /v1/branches/:id` `googleReviewUrl`, owner or `settings.operational`), returned in
`OwnerBranch` and `PublicBranch`.

## Diner flow

1. The tracking page (`/order/:token`) shows "How was it?" once the order reaches `askAfter`
   (and later, from the restaurant's recent orders on the menu), if reviews are enabled.
2. `GET /v1/public/orders/:token/review` returns `eligibility` (`OPEN`, `NOT_YET`, `EDITABLE`,
   `LOCKED`, `CLOSED`, `UNAVAILABLE`), the form (questions, tags, the order's dishes, how the name
   will appear), the diner's existing review if any (`hasContact`, never the phone), `editableUntil`
   and its `outcome`.
3. `PUT /v1/public/orders/:token/review` creates or edits it (idempotent per order, within the
   edit window): `{ overall 1–5, ratings?: { food: 1–5, … }, dishes?: [{ orderItemId, rating }],
   tags?: [], comment?, photoIds?: [], name?, contactPhone?, contactConsent, language, editKey? }`.
   - Rejected/cancelled orders, and orders placed more than 30 days ago, cannot be reviewed
     (409 `REVIEW_NOT_ELIGIBLE`, `details.eligibility: CLOSED`); before `askAfter`: `NOT_YET`;
     after the window: `LOCKED`.
   - `editKey`: a random key the browser keeps. A review written with one can only be edited with
     the same key (403 `REVIEW_EDIT_FORBIDDEN`), so a shared tracking link cannot change it.
   - Checked against the settings: sub-ratings and dish ratings not asked (400 `REVIEW_RATING_NOT_ASKED`),
     dishes not on this order (400 `REVIEW_DISH_NOT_IN_ORDER`), unknown tags, a missing comment
     below `commentRequiredBelow`, a phone without consent, photos not uploaded for this order.
   - Edits keep the previous review in the history (event `EDITED` with the rating before, and an
     audit entry `review.edited`), and go through the publishing rule again; a review a moderator
     hid stays hidden. The order and branch never change.
4. `POST /v1/public/orders/:token/review/photos` (multipart `file`, JPEG/PNG/WebP, max 5 MB) →
   `{ id, width, height }`. Up to 3 per review, up to 10 uploads per order; uploads not attached
   within a day are purged. The diner sees their own photos at
   `GET /v1/public/orders/:token/review/photos/:id`.
5. The response says what happens next: `outcome.status` `PUBLISHED`, `PENDING` (waiting for the
   restaurant) or `NOT_PUBLIC` (NEVER, or hidden), and `outcome.google: { url } | null`.
6. Unverified (if allowed): `POST /v1/public/restaurants/:subdomain/feedback` with optional
   `branch` (slug) / `tableCode` (decides the branch), same body without `dishes`, `photoIds` and
   `editKey` (it cannot be edited); 5 per IP per restaurant per day (counted once the feedback is
   valid; 429 `RATE_LIMITED`), and a `website` honeypot (filled: same answer, nothing kept).

## Restaurant side (`/v1/reviews`)

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /reviews?branchId=&stars=1,2&status=&verified=&hasComment=&followUp=OPEN\|CONTACTED\|RESOLVED\|NONE&from=&to=&q=&page=&pageSize=` | view | Inbox, newest first; `from`/`to` are local days; `q` searches comments, names, replies, tag codes and order numbers (`#12`) |
| `GET /reviews/:id` | view | With the order summary (number, dishes, total), dish ratings, photos, reply, follow-up and the full history |
| `GET /reviews/:id/photos/:mediaId` | view | Streams a photo (private ones too), never cached |
| `PUT /reviews/:id/reply` / `DELETE` | respond | One public reply, editable (the first reply time is kept for the stats); shown under the published review |
| `POST /reviews/:id/publish` / `POST /reviews/:id/hide` | moderate | Hide needs a `reason` (kept, audited as `review.hidden`); publish lifts it (`review.published`) |
| `PATCH /reviews/:id/follow-up` | respond | `{ status: OPEN \| CONTACTED \| RESOLVED, note?, assigneeId? }`; notes are internal, with history; `assigneeId: null` clears, omitted keeps |
| `GET /reviews/assignees?branchId=` | respond | Who a follow-up can be given to |
| `GET /reviews/stats?branchId=&days=` | view | Average and count per local day, distribution, sub-rating averages, tag frequency, dish ranking (≥ 3 ratings), reply rate and median reply time, share of unhappy diners (≤ 2 stars) contacted or resolved, verified share, pending moderation and open follow-ups now |
| `GET /reviews/dishes?branchId=&days=` | view | Per dish: rating average, count, up/down share, recent comments |
| `GET /reviews/export?…` | view | CSV (UTF-8 with BOM, formula-safe) with the inbox filters, up to 10,000 rows; the contact phone column only for callers holding `reviews.respond` |
| `GET/PUT /reviews/settings` | view or settings / settings | As above |

Reviews of other restaurants look unknown (404); staff tied to a branch see only its reviews
(another branch's: 403 `BRANCH_FORBIDDEN`). Follow-up assignees must be active accounts of the
restaurant holding `reviews.respond` at the review's branch (or every branch), otherwise 400
`REVIEW_ASSIGNEE_INVALID`.

Public (`showOnMenu`, publishing not NEVER): `GET /v1/public/restaurants/:subdomain/reviews?branch=&page=&pageSize=`
returns the summary (`average`, `count`, `distribution`, `verifiedCount`, `subRatings`, `policy`)
of every published review (of the branch, when given) and the published reviews, newest first,
with the restaurant's reply, dish ratings and public photos. The public menu's items carry
`rating: { average, count, positiveShare } | null` (null below `menuMinCount` or when hidden):
published reviews of every branch, attached after the cached menu from a cache of their own whose
key is bumped by every change to a published review and by the settings. `PublicRestaurant.reviews`
says whether the page and badges are shown (`page`), whether feedback is taken (`feedback`), and
the dish scale.

Realtime: `review.created` / `review.updated` (`{ review: OwnerReviewListItem }`, never with the
contact phone) to the `reviews:restaurant:{id}` and `reviews:branch:{id}` rooms of the `/owner`
namespace, which a socket joins at connection time only when its account holds `reviews.view`
(and only its branch's room when tied to a branch). Email: low-rating alert through the `email`
queue, once per review (`alerted_at`), also when an edit brings a review below the threshold, in
each recipient's language.

## Permissions

| Permission | Default roles |
| --- | --- |
| `reviews.view` | OWNER, MANAGER |
| `reviews.respond` | OWNER, MANAGER |
| `reviews.moderate` | OWNER, MANAGER |
| `reviews.settings` | OWNER |

All grantable to every staff role. Branch-tied staff see only their branch's reviews.
`reviews.view` alone reads reviews, stats and the export but not contact phones: those go to
`reviews.respond`, the people who call diners back.

## Integrity

- One review per order (unique `order_id`); unverified feedback has no order and is limited.
- Edits keep the original rating in history (audited); the diner cannot change the order or branch.
- Ratings are integers 1–5 (CHECK constraints); text lengths are bounded (comment 1000, name 40,
  reply 1000, notes 500, hide reason 300); photos go through the media pipeline (`kind = REVIEW`),
  stored under `private/` until the review is published, then moved to the public prefix (and back
  when hidden, removed by the diner, or while publishing is NEVER).
- Tenant isolation through `BranchScopeService`; staff ids (assignees) are checked against the restaurant.

## Decisions taken while building

- Contact phones are shown to `reviews.respond` holders (not every `reviews.view` holder), so a
  waiter granted read access never sees diners' numbers; this also decides the export's phone column.
- Reviews are accepted up to 30 days after the order was placed (`REVIEW_LIMITS.reviewWithinDays`).
- The edit window is fixed when the review is written; edits need the browser's `editKey` when the
  review was created with one.
- Publishing is re-decided on every diner edit (a manually approved review goes back to moderation
  when edited below the threshold or under MANUAL); hidden stays hidden.
- Under NEVER, new reviews are kept as PENDING (private); switching away from NEVER makes the
  published ones' photos public again.
- Dish badges are restaurant-wide (all branches) and count published reviews only; the summary and
  stats round averages to 2 decimals, menu badges to 1.
- Reviews below `alertBelowStars` open a follow-up automatically; "unhappy" in the stats means 1–2 stars.
- `GET /reviews/settings` is readable with `reviews.view` too, so the inbox can name tags and questions.

### Contact phone on edits

Diners never see their stored number again. An edit that leaves `contactPhone` out while `contactConsent` stays true keeps the stored number; sending an empty value or `contactConsent: false` removes it. Review photos are served with `Cross-Origin-Resource-Policy: cross-origin`, because the diner's page (the restaurant's subdomain) and the dashboard load them from another origin; access is limited by the order's tracking token or the staff session.
