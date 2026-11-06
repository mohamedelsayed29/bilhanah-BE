# Bilhanah (بالهنا): backend

Digital menus, ordering and order-ready alerts for restaurants in Egypt. Bilhanah is three repositories, cloned side by side:

| Repository | What it is |
| --- | --- |
| **bilhanah-BE** (this one) | NestJS API and background worker, the shared `packages/`, and `infra/` (local services, the production stack, deploys) |
| [bilhanah-client-FE](https://github.com/mohamedelsayed29/bilhanah-client-FE) | Everything restaurants and diners use: the public website and restaurant pages (`{subdomain}.bilhanah.com`), and in `dashboard/` the restaurants' dashboard (owners, staff, kitchen) |
| [bilhanah-dashboard-FE](https://github.com/mohamedelsayed29/bilhanah-dashboard-FE) | The Bilhanah dashboard: the platform admin console for Bilhanah's own team |

```
bilhanah/
  bilhanah-BE/
  bilhanah-client-FE/        website (src/) + restaurants' dashboard (dashboard/)
  bilhanah-dashboard-FE/     admin console
```

| Path | What it is |
| --- | --- |
| `src`, `test` | The API and worker (below) |
| `packages/contracts` | Request/response schemas and error codes shared with the website and dashboard |
| `packages/database` | Prisma schema and migrations |
| `packages/config` | Shared TypeScript settings |
| `infra` | Local services (`compose.dev.yml`), the production stack, Caddy and deploy/backup scripts ([runbook](infra/RUNBOOK.md)) |
| `scripts` | `dev.sh` (run everything), `seed-demo.mjs`, `sync-contracts.sh` |

## Run it locally

Requirements: git, Node.js 24+ and Docker (Docker Desktop with its engine running). Linux and macOS; on Windows, use WSL.

```bash
git clone https://github.com/mohamedelsayed29/bilhanah-BE
cd bilhanah-BE
bash run.sh            # first run: clones the website and dashboard next to this repository
bash run.sh --demo     # also creates the demo restaurant
bash run.sh --update   # pulls the latest main in all three repositories first
```

`run.sh` clones the other two repositories if they are missing, then runs `scripts/dev.sh` (also `npm run dev`). That creates `.env` on first run, installs dependencies, starts PostgreSQL, Redis and Mailpit in Docker, applies migrations, and runs the API, the worker, the website and the dashboard together. Ctrl+C stops the apps; `npm run services:down` stops the Docker services.

| | |
| --- | --- |
| Website | http://127.0.0.1:5180 |
| A restaurant's page | http://`<subdomain>`.localhost:5180 |
| Restaurants' dashboard (owners, staff, kitchen) | http://127.0.0.1:5174 |
| Admin console (Bilhanah team) | http://127.0.0.1:5175 |
| API | http://127.0.0.1:3000 (`/health/ready`) |
| Email sent by the app (Mailpit) | http://127.0.0.1:8025 |

Use `WEB_PORT=…` to run the website on another port. With the stack running, `npm run seed:demo` (or `bash run.sh --demo`) creates a demo restaurant with a full menu and photos at http://koshary-demo.localhost:5180 (owner `demo-owner@bilhanah.local` / `demo-password-1`, kitchen screen `demo-kitchen@bilhanah.local` / `demo-kitchen-1`).

| Command | Purpose |
| --- | --- |
| `npm run typecheck`, `npm run lint` | TypeScript check, lint |
| `npm test` | Unit tests (Vitest); `npm run test:contracts` for the contracts |
| `npm run test:e2e` | HTTP tests against the local services (isolated `bilhanah_test` database, Redis DB 1) |
| `npm run db:migrate` | Create/apply a migration after editing `packages/database/prisma/schema.prisma` |
| `npm run build` | Compile to `dist/` |
| `npm run start:dev`, `npm run start:worker:dev` | The API or the worker alone, in watch mode |

## Changing the contracts

`packages/contracts` lives here; the website and dashboard each keep a copy in their own `packages/` so they build on their own. After changing it:

```bash
npm run contracts:sync   # copies it into ../bilhanah-client-FE and ../bilhanah-dashboard-FE
```

then commit the copy in each frontend repository. Keep changes backward compatible (add fields; remove them a release later), since the three repositories deploy separately.

## Deploy

Production is one server with Docker Compose behind Caddy, with the three repositories cloned side by side; see [infra/RUNBOOK.md](infra/RUNBOOK.md) for provisioning, DNS, deploys, backups and how to try the production stack locally.

## The API

Stack: Node.js, NestJS, TypeScript, PostgreSQL, Prisma, Redis, BullMQ and Socket.IO.

| Directory | Responsibility |
| --- | --- |
| `src/config` | Validated environment configuration |
| `src/common` | Shared guards, decorators, filters, interceptors, and pipes |
| `src/infrastructure` | Database, Redis, queue, storage, email, and monitoring adapters |
| `src/modules` | Business modules organized by responsibility |
| `src/commands` | Controlled administrator bootstrap and maintenance commands |
| `test` | Database-backed integration and API tests |

The HTTP API (`src/main.ts`) and the background worker (`src/worker.ts`) are two entry points of this application and share its NestJS modules. Both run from the same Docker image; the worker's command is `node dist/worker.js`. The worker is not a separate microservice.

A business module can contain its module definition, controllers, services, scoped repository, policies, events, and colocated unit tests. Create these files when implementing the corresponding feature; empty TypeScript stubs are intentionally not generated.

Database schema and migrations belong in `packages/database`. Request/response contracts belong in `packages/contracts`. Never expose Prisma models or secrets directly to frontend clients.

## HTTP conventions

- Business routes are versioned under `/v1`; `GET /health` (liveness) and `GET /health/ready` (PostgreSQL + Redis) are not.
- Every response carries `x-request-id`; a well-formed upstream value is kept.
- Errors use one shape: `{ "error": { "code", "message", "details?", "requestId" } }`. Unexpected errors never expose internal messages.
- Validate request input with `ZodValidationPipe` and schemas from `packages/contracts`.
- JSON bodies are limited to 100 kB (413 `PAYLOAD_TOO_LARGE`); malformed JSON is 400 `VALIDATION_FAILED`.
- Environment variables are validated at startup by `src/config/env.schema.ts`; the process refuses to start with invalid configuration.

The project uses ES modules, so relative imports end in `.js`.


## Restaurant-owner authentication

All routes are under `/v1/auth`. Request bodies are validated by the schemas in `packages/contracts/src/auth`.

| Route | Result |
| --- | --- |
| `POST /register` | 202 always; sends a verification email (or an "account exists" email) |
| `POST /resend-verification` | 202 always |
| `POST /verify-email` `{ token }` | 200 `{ passwordSetupRequired }`, or 400 `INVALID_TOKEN`. `true` means the account has no password yet and a link to set one was emailed (see below) |
| `POST /login` | 200 `{ accessToken, accessTokenExpiresIn, user }` and the `bh_refresh` cookie |
| `POST /refresh` | Rotates the cookie and returns a new access token |
| `POST /logout` | 204; ends the session and clears the cookie |
| `POST /forgot-password` | 202 always |
| `POST /reset-password` `{ token, password }` | 204; signs out every session |
| `GET /me` | Current user (requires `Authorization: Bearer`) |
| `PATCH /me` `{ fullName?, preferredLanguage? }` | Updates the caller's name and email language (Bearer) |
| `GET /sessions` | Active sessions of the caller, with `current` marking this one (Bearer) |
| `DELETE /sessions/:id` | 204; signs out one of the caller's sessions, 404 for any other ID (Bearer) |
| `POST /change-password` `{ currentPassword, newPassword }` | 204; signs out every other session and voids reset links. 400 `INVALID_CREDENTIALS` for a wrong current password (Bearer) |

Registering an unconfirmed email a second time with a different password removes the account's password: either registration may have come from someone without access to the inbox. Confirming the email then returns `passwordSetupRequired: true` and sends a reset link, so only the inbox owner sets the password. Accounts never confirmed are deleted after 30 days.

Sessions last `REFRESH_TOKEN_TTL_DAYS` from their last use, but never more than `SESSION_MAX_DAYS` after sign-in. Behind a reverse proxy set `TRUST_PROXY` (for example `1`), or every client shares one rate-limit bucket.

Rules the dashboard must follow:

- Keep the access token in memory only; the refresh token lives in an HttpOnly cookie scoped to `/v1/auth` on the API host. Send requests with `credentials: 'include'`.
- `login`, `refresh` and `logout` require an `Origin` listed in `CORS_ORIGINS` (CSRF protection).
- Refresh tokens rotate on every use and reuse of an old token revokes the session. Never refresh concurrently: share one in-flight refresh across the app and across tabs (for example with `navigator.locks`).
- Email links put the token in the URL fragment: `/verify-email#token=…` and `/reset-password#token=…`.
- Protect owner routes in other modules with `@UseGuards(AccessTokenGuard)` and read the caller with `@CurrentAuth()`. The guard also checks that the session is still active and the account is not suspended.

Local email is caught by Mailpit at http://127.0.0.1:8025. The API queues email in Redis and the worker delivers it, retrying failures with backoff for about five minutes; if Redis is unreachable the API sends directly instead. Run `npm run dev:worker` to receive email locally. Administrators are rejected by the owner login; they sign in with `POST /auth/admin/login` (see Platform administration).

## Restaurants and onboarding

Owner routes require `Authorization: Bearer` and the `OWNER` role. They never take a restaurant id: every query is scoped to the caller's own restaurant.

| Route | Result |
| --- | --- |
| `GET /v1/restaurants/subdomain-availability?name=` | `{ subdomain, available, reason? }`, where reason is `INVALID`, `RESERVED` or `TAKEN` |
| `POST /v1/restaurants` | 201 with the restaurant and its `access`; starts the automatic trial. 409 `RESTAURANT_ALREADY_EXISTS` or `SUBDOMAIN_TAKEN` |
| `GET /v1/restaurants/mine` | The owner's restaurant, or 404 `RESTAURANT_NOT_FOUND` (send the owner to onboarding) |
| `PATCH /v1/restaurants/mine` | Update details. The subdomain cannot be changed; suspended restaurants get 403 |
| `GET /v1/public/restaurants/:subdomain` | Public view: `AVAILABLE` with contact details, or a neutral `TEMPORARILY_UNAVAILABLE` (same for expired and suspended) |

Rules:

- Subdomains: 3–40 lowercase letters, digits and single hyphens; reserved names are listed in `packages/contracts/src/restaurants`. Uniqueness is enforced by the database, so simultaneous claims cannot both succeed.
- One restaurant per owner account (unique `owner_id`), and one automatic trial per restaurant (partial unique index).
- The trial uses the global `trial_settings` row at creation time (default: enabled, 30 days, Advanced). Later changes do not affect existing trials. With trials disabled, the restaurant is created without access.
- Access is computed at request time from `entitlements` (`src/modules/subscriptions/access.ts`). Manual suspension overrides any entitlement.
- Plans and trial defaults are reference data inserted by migration: Menu EGP 200, Orders EGP 350 and Advanced EGP 500, stored in piastres.

## Menus and images

Owner routes need `Authorization: Bearer` and act only on the caller's restaurant; ids from other restaurants answer 404. Editing stays available while the subscription is inactive; only the public menu pauses. Schemas: `packages/contracts/src/menus.ts`, `media.ts`.

| Route | Result |
| --- | --- |
| `POST /media?kind=ITEM\|LOGO\|COVER` | multipart `file` (JPEG/PNG/WebP, max 5 MB, min 200 px). 201 `ImageSet`: WebP renditions for `srcset`. The original is not kept, so camera metadata and GPS never reach storage |
| `GET /menu` | The full menu, hidden entries included |
| `POST /menu/categories`, `PATCH`/`DELETE /menu/categories/:id` | Deleting a category deletes its items |
| `PUT /menu/categories/order` `{ ids }` | The complete new order (400 `ORDER_MISMATCH` otherwise) |
| `POST /menu/items`, `PATCH`/`DELETE /menu/items/:id` | `variants` (sizes) replace the item's list; one unnamed price, or named sizes, each with optional calories, portion and servings. `translations` hold extra languages. `isAvailable: false` = sold out |
| `PUT /menu/categories/:id/items/order` `{ ids }` | Order within a category |
| `PATCH /restaurants/mine` | Also `logoId`, `coverId` (images of that kind), `brandColor`, `openingHours` |

Limits: 50 categories, 500 items, 10 sizes per item; prices are piastres up to EGP 100,000.

Public, no auth, `Access-Control-Allow-Origin: *`:

| Route | Result |
| --- | --- |
| `GET /public/restaurants/:subdomain/menu` | `{ restaurant, categories }`: visible items (sold-out included), empty categories omitted. `categories` is empty while the restaurant is unavailable |
| `GET /public/plans` | Plan prices and features |
| `POST /public/contact` | Website contact form; goes to `CONTACT_INBOX` (5 per hour per IP) |

The public menu is cached in Redis under the restaurant's `menuVersion`, which every edit increments in the same transaction, so changes appear immediately. Images unused for a day are deleted by the worker.

**Languages.** Arabic (`nameAr`, required) and English (`nameEn`, optional) are the menu's built-in languages. A restaurant can also offer extra languages, `PATCH /restaurants/mine { menuLanguages: ['fr', 'ru'] }`, chosen from `EXTRA_MENU_LANGUAGES` (fr, de, it, es, ru, zh, tr; a CHECK in SQL refuses others). Their text lives in `translations` on categories (`{ fr: { name } }`), dishes (`{ fr: { name, description } }`) and sizes (`{ fr: { name } }`); sending a blank string removes one. Clients pick text with `menuName()` / `menuDescription()` from `packages/contracts/src/menu-languages.ts`: the language's own text, then English, then Arabic. That file is zod-free, so the diner menu can import it. Orders copy only the Arabic and English names.

**Calories and portions** are optional per size: `calories` (kcal, 0–10,000), a portion as `portionValue` + `portionUnit` (`GRAM`, `ML` or `PIECE`; both or neither, enforced in SQL too) and `serves` (1–50). Sizes are updated in place by position, so editing them keeps branch prices.

Images are stored with `STORAGE_DRIVER=local` (in `var/media`, served at `/media`) or `s3` (Cloudflare R2 in production); see `.env.example`.

## Ordering

Diners order from the public menu without an account; the restaurant handles orders on a live board. Schemas: `packages/contracts/src/orders.ts`. Orders flow only when the plan includes ordering (Orders, Full Experience) **and** the owner has switched it on (`PATCH /restaurants/mine` `{ orderingEnabled, acceptsDineIn, acceptsPickup, ordersPaused }`; at least one order type stays on, and switching ordering on needs a plan that includes it); `GET /public/restaurants/:subdomain` exposes `ordering.accepting`.

| Route | Result |
| --- | --- |
| `POST /public/restaurants/:subdomain/orders` + `Idempotency-Key` header | 201 `{ trackingToken, order }`. Names and prices come from the menu (clients send ids, sizes, quantities and notes only). A retry with the same key returns the same order. 409 `ORDERING_UNAVAILABLE`, `RESTAURANT_CLOSED` (opening hours), `ITEMS_UNAVAILABLE` (`details.menuItemIds`); 400 `ORDER_TYPE_UNAVAILABLE`; 404 `TABLE_NOT_FOUND`. Limited to 60 orders per 10 minutes per client IP per restaurant (diners often share the restaurant's Wi-Fi) and 200 per IP overall Dine-in needs `tableCode` (from the table QR) or `tableLabel`; pickup needs `customerPhone` |
| `GET /public/orders/:trackingToken` | The diner's order and status (no phone number) |
| `GET /public/restaurants/:subdomain/tables/:code` | `{ label, branch }` of a scanned table |
| `GET /orders?view=active\|history` (owner) | The board (oldest first) or closed orders (newest first) |
| `PATCH /orders/:id/status` `{ status, reason? }` | A reason is required to reject or cancel (shown to the diner). Only the transitions in `ORDER_TRANSITIONS` (PLACED → ACCEPTED/REJECTED → PREPARING → READY → COMPLETED, or CANCELLED); 409 `INVALID_STATUS_CHANGE` otherwise or when another device moved it first |
| `GET/POST /tables`, `POST /tables/range` `{ from, to, prefix }`, `PATCH`/`DELETE /tables/:id`, `POST /tables/:id/code` | Tables and their QR links (`qrUrl` = `{publicUrl}/?t={code}`); a new code retires printed ones |

Order numbers restart at #1 each day per branch, in the restaurant's time zone. Ordering switches and opening hours are per branch (see Branches). Tracking tokens are the order id plus an HMAC, so they cannot be guessed and a retried checkout gets the same link.

**Live updates** use Socket.IO at path `/v1/realtime`, WebSocket transport only (no sticky sessions needed behind the load balancer; a Redis adapter relays events between API replicas). Namespace `/owner` with `auth: { token: <access token> }` receives `order.created`, `order.updated` and `restaurant.updated` (ordering settings changed, e.g. paused on another device) for the owner's restaurant and is disconnected when the token expires (reconnect with a fresh one). Namespace `/track` with `auth: { token: <tracking token> }` receives `order.updated` for that order. Clients should also refetch on reconnect.

## Branches

A restaurant is the brand: one subdomain, one shared menu, one subscription, one look. A **branch** is a location with its own contact details, opening hours and ordering switches; tables, orders (numbered per branch and day) and staff belong to a branch. Every restaurant has exactly one **main** branch (diners land there when they do not pick one; a partial unique index enforces it). Existing restaurants got theirs, named "الفرع الرئيسي" with slug `main`, from migration `20261102000000_branches`, which moved their hours, ordering settings, tables, orders and order counters onto it. Schemas: `packages/contracts/src/branches.ts`.

| Route | Who | Result |
| --- | --- | --- |
| `GET /branches` | owner, staff | `{ branches, limit, used }`; staff tied to a branch get only theirs |
| `POST /branches` | owner | `{ name, slug, phone, city, address, whatsappNumber?, mapUrl?, openingHours?, copyTablesFrom? }`. 409 `BRANCH_LIMIT_REACHED` (`details.limit`) or `BRANCH_SLUG_TAKEN` |
| `GET`/`PATCH /branches/:id` | owner, manager | Managers may change contact details, hours and ordering switches, not `name`, `slug` or `isActive` (403, `details.fields`). `isActive: false` archives (409 `MAIN_BRANCH_LOCKED` for the main branch) |
| `DELETE /branches/:id` | owner | Only for branches without orders (409 `BRANCH_HAS_ORDERS`: archive instead) or staff (409 `BRANCH_HAS_STAFF`) |
| `POST /branches/:id/main`, `POST /branches/reorder` `{ ids }` | owner | Moves the main role (the branch must be active); sets the order |
| `GET /branches/:id/menu` | owner, staff | The shared menu with the branch's `override` and the `effective` result per dish |
| `PUT /branches/:id/menu/items/:itemId` | owner, manager, kitchen | `{ available?: boolean \| null, hidden?, prices?: [{ variantId, pricePiastres \| null }] }`; kitchen screens may only send `available` |
| `POST /branches/:id/menu/reset`, `POST /branches/:id/menu/copy-from/:sourceId` | owner (+ manager for reset) | Back to the shared menu; copy another branch's overrides |
| `GET /restaurants/mine/stats?branchId=`, `GET /restaurants/mine/stats/branches?days=` | owner (manager: own branch only) | Insights for one branch (visits stay restaurant-wide); a side-by-side comparison |

Plans set the allowance of active branches (`PLAN_FEATURES[plan].branches`: Menu 1, Orders 3, Full Experience 10; archived branches do not count). Without access, existing branches stay and new ones wait.

**Overrides.** A branch can mark a shared dish sold out (or back in stock) on its own, hide it, and set its own price per size; everything else follows the shared menu. The public menu, the owner's branch menu and order pricing all go through `src/modules/branches/branch-menu.ts`. Editing a dish keeps its sizes' ids (matched by position), so branch prices survive renames and shared price changes. Override changes bump `menuVersion`, so the cached public menu refreshes at once.

**Diners.** `GET /public/restaurants/:subdomain[/menu]?branch=slug` returns the chosen branch (main when omitted) in `branch`, every active branch in `branches`, and the branch's contact details, hours, ordering and prices in the usual fields; unknown or archived slugs answer 404 `BRANCH_NOT_FOUND`. A branch's own link is `{publicUrl}/?b={slug}`. Orders take `branch` (slug); a `tableCode` decides the branch by itself. The table lookup returns `{ label, branch }`, and tracked orders include `branch`.

**Staff.** `POST/PATCH /kitchen-accounts` take `role` (`KITCHEN` or `MANAGER`) and `branchId` (null: every branch). Changing either signs the account out. Managers run their branch: board, floor, bills, tables, branch menu overrides, branch settings and insights; `GET /kitchen/context` tells a staff screen its role, branch and branches, and the plan's effective `features` (all off without access), so staff screens offer inventory without probing its routes. Every owner and staff query goes through `BranchScopeService` (`src/modules/branches/branch-scope.service.ts`): other restaurants' branch ids answer 404, another branch of the caller's own restaurant 403 `BRANCH_FORBIDDEN`.

**Compatibility.** `PATCH /restaurants/mine` still accepts `openingHours`, `orderingEnabled`, `acceptsDineIn`, `acceptsPickup` and `ordersPaused`, applied to the main branch; `GET /restaurants/mine` reports the main branch's (plus `mainBranchId` and `branchCount`). While a restaurant has one branch, its phone, city, address and WhatsApp stay in step with the branch.

**Live updates.** Owners and all-branch staff join the restaurant's room; staff tied to a branch join that branch's room. `restaurant.updated` carries `{ branchId, ordering }`.

## Order-ready alerts (Full Experience plan)

On the Full Experience plan, the tracking page rings and vibrates when the order is ready, and diners can turn on Web Push to hear about it with the page closed (on iPhone, after adding the menu to the Home Screen). Schemas: `packages/contracts/src/push.ts` and `pushSubscriptionSchema` in `orders.ts`.

| Route | Result |
| --- | --- |
| `GET /public/orders/:trackingToken/alerts` | `{ readyAlerts, push }`: whether the page may ring (the plan), and `push.publicKey` (VAPID) when push is available |
| `POST /public/orders/:trackingToken/push` `PushSubscription.toJSON() + { language }` | 204. Only browser push services (`PUSH_SERVICE_HOSTS`: FCM, Mozilla, Apple, Windows), so diners cannot make the server call other hosts. Five browsers per order (the oldest makes room). 409 `PUSH_UNAVAILABLE` with `details.reason` `PLAN`, `NOT_CONFIGURED` or `ORDER_FINISHED` (ready or closed) |
| `DELETE /public/orders/:trackingToken/push` `{ endpoint }` | 204, also when already gone |
| `GET /public/restaurants/:subdomain/manifest.webmanifest?start=/order/:trackingToken` | A web app manifest for the restaurant's site; `start` makes an install open that order |
| `GET /public/restaurants/:subdomain/icon-{180,192,512}.png` | The logo (or the Bilhanah mark) centred on white, inside the maskable safe zone; cached in Redis per logo |

When an order becomes READY, REJECTED or CANCELLED, the API queues one job per subscribed browser (`push` queue, job id `{subscription}_{status}` so a status is never sent twice). The worker writes the notification in the diner's language, links the tracking page, and sends it with a 1-hour TTL and the order as the topic (a newer update replaces an undelivered older one). Push services answering 403/404/410 mean the subscription is dead and it is deleted; 400/413 are dropped; anything else is retried with backoff. Owners see a bell on orders whose diner turned notifications on (`OwnerOrder.notifiesDiner`, live over `order.updated`). Subscriptions are deleted an hour after their order is finished, and after two days at most.

Push needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npm run vapid:generate`; `npm run dev` adds a pair to `.env`). Without them the tracking page still rings while open.

## Subscriptions and billing (manual transfer)

Owners pay by InstaPay, Vodafone Cash or bank transfer and send the details for review; an administrator approves (creating a paid period) or rejects them. Schemas: `packages/contracts/src/billing.ts`.

| Route (owner, Bearer) | Result |
| --- | --- |
| `GET /billing` | Access, plan prices, billing periods (1/3/6/12 months), payment instructions and the methods that are set up, when a new period would start, the pending payment and history |
| `POST /billing/payments` `{ planCode, months, method, reference, payerName?, proofId? }` | 201; the amount is computed from the current plan price. 409 `PAYMENT_ALREADY_PENDING` (one at a time), 400 `PAYMENT_METHOD_UNAVAILABLE` |
| `DELETE /billing/payments/:id` | Withdraw a payment that is still pending |
| `GET /billing/payments/:id/proof` | The receipt image (`private, no-store`) |

Receipts are uploaded with `POST /media?kind=PAYMENT_PROOF`. They are stored under `private/`, never get public URLs, and are only streamed by the API to their owner and administrators.

A paid period starts when current coverage ends (so paying during the trial keeps the remaining trial days) or immediately when access has lapsed, and runs for whole calendar months. The worker emails owners 7, 3 and 1 days before a trial or paid period ends and once when it has ended, unless another period follows.

## Online payments (Paymob)

With the `PAYMOB_*` settings (and `API_PUBLIC_URL`), owners can pay for a plan by card or wallet, and stand-shop customers can pay online. Without them, everything works with transfers and cash on delivery. `src/infrastructure/paymob`.

1. The API creates a payment intention (`POST {PAYMOB_API_URL}/v1/intention/`, `Authorization: Token <secret key>`) for the amount it computed, with a unique `special_reference` (`sub-<payment id>-…` or `stand-<order id>-…`), `notification_url` = `{API_PUBLIC_URL}/v1/webhooks/paymob` and a `redirection_url` back to the dashboard or website. The customer is sent to `{PAYMOB_CHECKOUT_URL}?publicKey=…&clientSecret=…`.
2. Paymob calls `POST /v1/webhooks/paymob?hmac=…` with the transaction. Only callbacks whose HMAC-SHA512 (over Paymob's 20 documented fields, keyed with `PAYMOB_HMAC_SECRET`) matches are trusted; others get 401.
3. A successful transaction for the right amount in EGP credits its payment or order: a subscription gets its paid period exactly as if an administrator had approved a transfer; a stand order becomes NEW and PAID. Declines mark subscription payments FAILED. Callbacks are idempotent (transaction ids are unique), a late payment for an abandoned checkout still counts, and refunds, voids, duplicate charges and amount mismatches are written to the audit log for a person to handle.

| Route | Result |
| --- | --- |
| `POST /billing/online` `{ planCode, months }` (owner) | 201 `{ paymentId, checkoutUrl }`; an earlier unfinished checkout is cancelled. 409 `ONLINE_PAYMENT_UNAVAILABLE` (`details.reason` `NOT_CONFIGURED` or `PROVIDER_ERROR`) |
| `POST /webhooks/paymob?hmac=` | Paymob's transaction callback (see above) |

Unfinished subscription checkouts are cancelled after a day; `GET /billing` shows them as `AWAITING_PAYMENT`, then `APPROVED`, `FAILED` or `CANCELLED`.

**Without a Paymob account:** `bash run.sh --paymob-sandbox` points the API at `scripts/paymob-sandbox.mjs`, a local stand-in that answers the Intention API, shows a checkout page with "Pay" and "Decline", then sends a correctly signed callback and returns the customer, as Paymob does. It changes `.env` only if no real `PAYMOB_SECRET_KEY` is there. To use real Paymob locally, the callback URL must be reachable from the internet (a tunnel such as `cloudflared` for `API_PUBLIC_URL`).

## Stand shop

Customers order acrylic QR/NFC stands without an account. Prices live in `packages/contracts/src/shop.ts` (`STAND_PRICES`) and are always computed here. Schemas: `shop.ts`, `shop-orders.ts`.

| Route | Result |
| --- | --- |
| `GET /public/shop` | Prices, the delivery fee (null: confirmed by phone) and the payment methods on offer. Online payment needs Paymob, the setting, and a fixed fee |
| `POST /public/shop/logos` (multipart `file`, PNG/JPEG/WebP ≤ 3 MB) | 201 `{ logoId }`; stored privately, re-encoded as PNG. Unused logos are deleted after two days |
| `POST /public/shop/orders` + `Idempotency-Key` | 201 `{ trackingToken, order, checkoutUrl }`. 409 `PRICE_CHANGED` when `expectedTotalPiastres` differs from today's total; 400 `PAYMENT_METHOD_UNAVAILABLE`; 404 `LOGO_NOT_FOUND`. Online orders wait as `AWAITING_PAYMENT` (cancelled after two days) and nothing is saved if Paymob cannot open a checkout |
| `GET /public/shop/orders/:token`, `POST …/:token/pay` | The customer's order page; a new checkout for an unpaid online order |
| `GET /admin/stand-orders?status=open\|<status>&query=`, `GET/PATCH /admin/stand-orders/:id`, `PATCH …/:id/status` `{ status, note? }`, `GET …/:id/lines/:lineId/logo` | The fulfilment queue: NEW → CONFIRMED → IN_PRODUCTION → SHIPPED → DELIVERED, or CANCELLED (with a reason). Every change is in the order's history and the audit log, and the customer is emailed |
| `GET/PUT /admin/settings/shop` | Delivery fee, cash on delivery, online payment |

## Insights

Restaurant pages send `POST /public/restaurants/:subdomain/visits { source: qr | table | link }` once per load. A visitor counts once per restaurant and day: they are recognised by a SHA-256 of their IP address and browser with a salt derived from the server secret and the date, so no address is stored and nobody can be followed across days. Counters live in Redis (8 days) and the worker copies them to `restaurant_daily_stats` hourly.

| Route | Result |
| --- | --- |
| `GET /restaurants/mine/stats?days=7\|30\|90` (owner) | Daily visits, orders and revenue (restaurant time zone; rejected and cancelled orders excluded), how diners arrived, dine-in vs pickup, the top five dishes |
| `GET /admin/stats?days=7\|30\|90` | Platform totals per Cairo day (visits, orders, new restaurants, subscription revenue), stand orders and their revenue, the ten most visited restaurants |

## Platform administration

Administrators sign in with `POST /auth/admin/login` `{ email, password, code }`, where `code` comes from an authenticator app (TOTP, RFC 6238). Codes cannot be reused, wrong passwords and wrong codes get the same answer, and administrator sessions end `ADMIN_SESSION_HOURS` (12) after sign-in. Authenticator secrets are stored encrypted (AES-256-GCM, `DATA_ENCRYPTION_KEY`).

Routes under `/admin` require an administrator; every change is written to the audit log in the same transaction.

| Route | Result |
| --- | --- |
| `GET /admin/overview` | Restaurants by access status, pending payments, monthly recurring revenue, periods ending within 7 days |
| `GET /admin/restaurants?query=&access=&page=` | Search by name, subdomain, owner email or phone |
| `GET /admin/restaurants/:id` | Details, periods and payments |
| `POST /admin/restaurants/:id/suspend` `{ reason }`, `/unsuspend` | Takes the public menu offline and blocks the owner's edits; data is kept |
| `POST /admin/restaurants/:id/entitlements` `{ planCode, months, note }` | Grant a paid period by hand (cash, corrections) |
| `GET /admin/payments?status=PENDING`, `GET /admin/payments/:id`, `/proof` | The review queue (oldest first) and receipts |
| `POST /admin/payments/:id/approve`, `/reject` `{ reason }` | The owner is emailed either way |
| `GET /admin/settings`, `PUT /admin/settings/payment`, `PUT /admin/settings/trial`, `PUT /admin/plans/:code` | Payment details shown to owners, trial defaults for new restaurants, plan prices (pending payments keep their amount) |
| `GET /admin/audit?page=` | Who did what, newest first |

## Provisioning an administrator

```bash
npm run admin:create -- --email admin@bilhanah.com --name "Platform Admin"
```

The password (at least 12 characters) is typed at a hidden prompt, or piped as the first line of standard input. It is never passed as an argument, so it does not end up in shell history or process listings. The command refuses to reuse an existing email and never promotes a restaurant owner.

It prints an authenticator key (and an `otpauth://` link) once; add it to an authenticator app, since sign-in needs a 6-digit code. If an administrator loses their phone, issue a new key, which also signs them out everywhere:

```bash
npm run admin:reset-mfa -- --email admin@bilhanah.com
```
