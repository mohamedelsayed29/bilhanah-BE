# NestJS Backend

Planned stack: Node.js, NestJS, TypeScript, PostgreSQL, Prisma, Redis, BullMQ, and Socket.IO.

| Directory | Responsibility |
| --- | --- |
| `src/config` | Validated environment configuration |
| `src/common` | Shared guards, decorators, filters, interceptors, and pipes |
| `src/infrastructure` | Database, Redis, queue, storage, email, and monitoring adapters |
| `src/modules` | Business modules organized by responsibility |
| `src/commands` | Controlled administrator bootstrap and maintenance commands |
| `test` | Database-backed integration and API tests |

The HTTP API and background worker will use separate entry points in this application and share NestJS modules. The worker is not a fourth application or a separate microservice.

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
- Environment variables are validated at startup by `src/config/env.schema.ts`; the process refuses to start with invalid configuration.

The project uses ES modules, so relative imports end in `.js`.


## Restaurant-owner authentication

All routes are under `/v1/auth`. Request bodies are validated by the schemas in `packages/contracts/src/auth`.

| Route | Result |
| --- | --- |
| `POST /register` | 202 always; sends a verification email (or an "account exists" email) |
| `POST /resend-verification` | 202 always |
| `POST /verify-email` `{ token }` | 204, or 400 `INVALID_TOKEN` |
| `POST /login` | 200 `{ accessToken, accessTokenExpiresIn, user }` and the `bh_refresh` cookie |
| `POST /refresh` | Rotates the cookie and returns a new access token |
| `POST /logout` | 204; ends the session and clears the cookie |
| `POST /forgot-password` | 202 always |
| `POST /reset-password` `{ token, password }` | 204; signs out every session |
| `GET /me` | Current user (requires `Authorization: Bearer`) |

Rules the dashboard must follow:

- Keep the access token in memory only; the refresh token lives in an HttpOnly cookie scoped to `/v1/auth` on the API host. Send requests with `credentials: 'include'`.
- `login`, `refresh` and `logout` require an `Origin` listed in `CORS_ORIGINS` (CSRF protection).
- Refresh tokens rotate on every use and reuse of an old token revokes the session. Never refresh concurrently: share one in-flight refresh across the app and across tabs (for example with `navigator.locks`).
- Email links put the token in the URL fragment: `/verify-email#token=…` and `/reset-password#token=…`.
- Protect owner routes in other modules with `@UseGuards(AccessTokenGuard)` and read the caller with `@CurrentAuth()`. The guard also checks that the session is still active and the account is not suspended.

Local email is caught by Mailpit at http://127.0.0.1:8025. Email is currently sent in the background from the API process; it moves to the outbox/worker pipeline when that is built. Administrator login (with MFA) is not implemented yet; administrators are rejected by the owner login.

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

## Provisioning an administrator

```bash
npm run admin:create -- --email admin@bilhanah.com --name "Platform Admin"
```

The password (at least 12 characters) is typed at a hidden prompt, or piped as the first line of standard input. It is never passed as an argument, so it does not end up in shell history or process listings. The command refuses to reuse an existing email and never promotes a restaurant owner. Administrator sign-in with two-factor authentication is not implemented yet.
