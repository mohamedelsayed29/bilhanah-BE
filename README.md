# Bilhanah Public Web

React + TypeScript + Vite landing page with the Teal & Guava identity.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

Open the printed localhost URL. Run commands from this directory.

## Validate and build

```sh
pnpm run typecheck
pnpm run build
pnpm run test:e2e
```

Browser tests use the installed Chrome channel and start/reuse a local Vite server. Production files are emitted to `dist/`.

## Features

- Arabic/English page with persisted language preference and RTL/LTR layout.
- Three-scene live-action background video with pause/play, chapter selection, reduced-motion support, and poster fallback.
- Working illustrative restaurant menu, category filters, sizes, cart quantities, and explicitly simulated confirmation.
- Real QR linking to the sample menu, with clipboard support.
- Plans at EGP 200/350/500 per month, trial details, FAQ, and mobile navigation.
- Accessible native dialogs and honest registration-coming-soon messaging.

## Important boundaries

Account creation, subscriptions, restaurant administration, payments, and real orders are not connected to a backend. Trial actions show availability information and link to the sample rather than claiming account creation. The sample restaurant, dishes, and dish prices are illustrative. Ready alerts and vibration are described with device limitations.

## Where to edit

| Location | Purpose |
| --- | --- |
| `src/features/marketing/components` | Landing sections and sample menu |
| `src/features/marketing/data/plans.ts` | Initial prices and translated feature lists |
| `src/features/marketing/data/menu.ts` | Illustrative restaurant menu |
| `src/styles/global.css` | Brand tokens and responsive styles |
| `src/lib/language.tsx` | Language preference and formatting |
| `public/media` | Optimized photos and the background movie |
| `docs/ASSETS.md` | Image sources, exact generation prompts, and video provenance |

The hero MP4 is a 14.08-second edit of real Pexels footage with natural hand/phone motion. It does not animate still photographs. A reproducible local editing script and footage credits are documented in docs/ASSETS.md. Self-hosted fonts and all visual assets are served locally. The current static preview is configured in `.openai/hosting.json`.
