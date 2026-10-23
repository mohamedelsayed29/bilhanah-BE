# NestJS Backend

Stack: Node.js, NestJS, TypeScript, PostgreSQL, Prisma, Redis and BullMQ. Socket.IO is planned for live orders.

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

## Running locally

From the repository root:

```bash
cp .env.example .env     # first time only
npm install
npm run services:up      # PostgreSQL 18, Redis 8, Mailpit in Docker
npm run db:deploy        # apply migrations
npm run dev:api          # http://127.0.0.1:3000
npm run dev:worker       # background jobs: email delivery, hourly cleanup
```

| Command (root) | Purpose |
| --- | --- |
| `npm run typecheck:api` | TypeScript check |
| `npm run test:api` | Unit tests (Vitest) |
| `npm run test:api:e2e` | HTTP tests against the local services (isolated `bilhanah_test` database, Redis DB 1) |
| `npm run db:migrate` | Create/apply a migration after editing `packages/database/prisma/schema.prisma` |
| `npm run build:api` | Compile to `dist/` |

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

Local email is caught by Mailpit at http://127.0.0.1:8025. The API queues email in Redis and the worker delivers it, retrying failures with backoff for about five minutes; if Redis is unreachable the API sends directly instead. Run `npm run dev:worker` to receive email locally. Administrator login (with MFA) is not implemented yet; administrators are rejected by the owner login.

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
| `POST /menu/items`, `PATCH`/`DELETE /menu/items/:id` | `variants` (sizes) replace the item's list; one unnamed price, or named sizes. `isAvailable: false` = sold out |
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

Images are stored with `STORAGE_DRIVER=local` (in `var/media`, served at `/media`) or `s3` (Cloudflare R2 in production); see `.env.example`.

## Provisioning an administrator

```bash
npm run admin:create -- --email admin@bilhanah.com --name "Platform Admin"
```

The password (at least 12 characters) is typed at a hidden prompt, or piped as the first line of standard input. It is never passed as an argument, so it does not end up in shell history or process listings. The command refuses to reuse an existing email and never promotes a restaurant owner. Administrator sign-in with two-factor authentication is not implemented yet.
