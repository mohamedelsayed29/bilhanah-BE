# Bilhanah Public Web

React + TypeScript + Vite landing page with the Teal & Guava identity.

## Run locally

```sh
npm ci
npm run dev
```

Open the printed localhost URL. Run commands from this directory.

## Validate and build

```sh
npm run typecheck
npm run build
npm run test:e2e
```

Browser tests use the installed Chrome channel and start/reuse a local Vite server. Production files are emitted to `dist/`.

## Features

- Arabic/English page with persisted language preference and RTL/LTR layout.
- Three-scene live-action background video with pause/play, chapter selection, reduced-motion support, and poster fallback.
- Working illustrative restaurant menu, category filters, sizes, cart quantities, and explicitly simulated confirmation.
- Real QR linking to the sample menu, with clipboard support.
- Plans at EGP 200/350/500 per month, trial details, FAQ, and mobile navigation.
- Accessible native dialogs and honest registration-coming-soon messaging.

## Restaurant pages

On `{subdomain}.{VITE_ROOT_DOMAIN}` the app renders the restaurant's public page instead of the landing (`src/features/restaurant-menu`). It reads `GET /v1/public/restaurants/:subdomain` from `VITE_API_URL` and shows the restaurant's details, a neutral "temporarily unavailable" page for expired or suspended restaurants, or "restaurant not found". Locally, open `http://{subdomain}.localhost:5173`. The menu itself arrives in phase 2. Unless the visitor has chosen a language, the page uses the restaurant's default language.

## Configuration

See `.env.example`: `VITE_API_URL`, `VITE_ROOT_DOMAIN` (production `bilhanah.com`) and `VITE_DASHBOARD_URL`.

## Important boundaries

Subscriptions, payments, and real orders are not connected yet. Account creation exists in the dashboard but is not deployed: while `VITE_DASHBOARD_URL` is empty, trial actions keep the "registration coming soon" notice and link to the sample. Setting it makes the trial dialog link to `{VITE_DASHBOARD_URL}/register`. The sample restaurant, dishes, and dish prices are illustrative. Ready alerts and vibration are described with device limitations.

## Where to edit

| Location | Purpose |
| --- | --- |
| `src/features/marketing/components` | Landing sections and sample menu |
| `src/features/marketing/data/plans.ts` | Initial prices and translated feature lists |
| `src/features/marketing/data/menu.ts` | Illustrative restaurant menu |
| `src/styles/global.css` | Brand tokens and page styles |
| `src/styles/hero.css` | Responsive header, original logo viewport, and hero composition |
| `public/brand` | Transparent vector logo and original raster source |
| `src/lib/language.tsx` | Language preference and formatting |
| `public/media` | Optimized photos and the background movie |
| `docs/ASSETS.md` | Image sources, exact generation prompts, and video provenance |

The hero MP4 is a 14.08-second edit of real Pexels footage with natural hand/phone motion. It does not animate still photographs. A reproducible local editing script and footage credits are documented in docs/ASSETS.md. Self-hosted fonts and all visual assets are served locally. The current static preview is configured in `.openai/hosting.json`.
