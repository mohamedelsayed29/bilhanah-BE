# Restaurant and Admin Dashboard

Planned stack: React, TypeScript, Vite, React Router, and TanStack Query.

## Feature areas

- `src/features/auth`: login, verification, recovery, and administrator MFA.
- `src/features/onboarding`: restaurant details and subdomain selection.
- `src/features/restaurant`: owner overview, menu, orders, tables, QR codes, subscription, and settings.
- `src/features/admin`: platform overview, restaurants, plans, trials, promotions, payments, reports, settings, and audit.

## Shared application folders

- `src/app`: providers and role-aware route composition.
- `src/components`: dashboard-only reusable components.
- `src/layouts`: authentication, owner, and platform-admin shells.
- `src/lib`: API/session/realtime clients and error handling.
- `src/locales/ar` and `src/locales/en`: dashboard translations.
- `src/styles`: application styling.
- `tests`: application integration tests.

Frontend route guards improve navigation; authorization must still be enforced by the backend. This is a directory skeleton, not an initialized React application.
