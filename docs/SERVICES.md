# Restaurant services and flexible onboarding

Bilhanah does not force one workflow on every restaurant. A restaurant can:

- keep its own QR menu,
- run without any QR menu,
- or use Bilhanah's digital menu.

In all three cases it switches on only the services it needs.

## Services

The catalog lives in `packages/contracts/src/services.ts`.

| Key | What it covers | Needs | Plan feature |
| --- | --- | --- | --- |
| `DIGITAL_MENU` | Menu, dishes, QR codes, menu languages, suggestions, the public menu | — | `menu` |
| `QR_ORDERING` | Ordering from the menu, order board, service requests, kitchen display | `DIGITAL_MENU` | `ordering` |
| `REVIEWS` | Feedback and reviews | `DIGITAL_MENU` | `reviews` |
| `INVENTORY` | Stock, purchases, waste, counts, recipes and costing | — | `inventory` |
| `CASH_DRAWER` | Cashier shifts and cash movements | — | every plan |
| `ATTENDANCE` | Staff attendance and kiosks | — | every plan |

The core is always on: profile, branches, team and permissions, reports, and support.

### Adding a service

1. Add a key to `RESTAURANT_SERVICES`.
2. Add a rule to `SERVICE_RULES`.
3. Add a value to the `RestaurantServiceKey` database enum (a migration).
4. Add a label to `SERVICE_LABELS`.
5. Add an entry to the dashboard catalog (`features/services/catalog.ts`).

Then guard the new service's routes with `@RequireService('KEY')`.

## How a service's state is stored and applied

### Storage

`restaurant_services` holds one row per switched service.

When a restaurant has no row for a service, that service is **on**. This is how every restaurant worked before services existed, so existing restaurants keep working unchanged.

### Applying the state

`SubscriptionsService.accessFor` narrows the plan's features to the services that work (`featuresWithServices`).

- A service works only while it and everything it needs is on.
- Every existing check (`features.ordering`, `features.reviews`, `features.inventory`, `features.menu`) therefore follows the services with no extra code.
- `access.planFeatures` still says what the plan itself includes.

### Guards for the remaining services

Cash and attendance are not plan features. They are guarded separately:

- **HTTP routes**: `ServiceGuard` with `@RequireService(key)` refuses with 409 `SERVICE_INACTIVE`.
- **Attendance kiosks**: they stop taking punches.
- **Order payments**: they skip the cash drawer instead of requiring a shift.

### The public menu

With the digital menu off, the public menu answers `TEMPORARILY_UNAVAILABLE`.

### Switching services on and off

Only the owner may switch services: role `OWNER` with the `settings.manage` permission.

- Switching **on** needs:
  - the plan to include the service (409 `SERVICE_NOT_IN_PLAN`);
  - every service it needs to be on already (409 `SERVICE_REQUIREMENTS`).
- Switching **off** is refused while a service that needs it is on (409 `SERVICE_DEPENDENTS`).
- Switching **never deletes data**. It changes one row and writes one audit record (`service.enabled` / `service.disabled`).

Switches on one restaurant are serialised with an advisory lock.

## Onboarding

1. Account.
2. Restaurant details. This creates the restaurant and starts the trial.
3. `/setup`:
   - Does the restaurant already have a QR menu? Keep it (`EXTERNAL`, optional link), skip it (`NONE`), or use Bilhanah's (`BILHANAH`).
   - Does it use a POS? Optional name.
   - Which services to start with.

`PUT /v1/restaurants/mine/setup` saves these answers and marks `setup_completed_at`.

- **Skipping** saves only the menu answer, so every service stays on.
- **Until setup is done**, the overview shows a prompt to finish it.
- **Restaurants created before this feature** were marked done by the migration.

Owners change all of this later in **Settings → Services**. The endpoints are:

- `GET /v1/restaurants/mine/setup`
- `PUT /v1/restaurants/mine/services/:key`

## Dashboard

### Navigation

Owner, manager and kitchen navigation show a page only while its service works.

- Owners: from `OwnerRestaurant.setup.services`.
- Staff: from `KitchenContext.services`.

### Pages of a switched-off service

Pages of a service that is off show a contextual prompt (`RequireService` in the router):

- what the service brings;
- what it needs;
- for the owner, a button that switches it on, with its requirements first.

### Overview without the digital menu

Without the digital menu, the overview drops the menu cards and lists the restaurant's services instead.

## Data sources and integrations

Bilhanah-owned data is kept apart from data brought in from other systems.

### Recording the source

- `orders.source` (`DataSource`: `BILHANAH` | `EXTERNAL`) records where an order came from. Every order placed on Bilhanah is `BILHANAH`.
- A future POS integration writes `EXTERNAL` orders. It never changes Bilhanah's own.

### Reports

Reports (`RestaurantStats.dataSource`) state what they count:

- Bilhanah orders only;
- plus the restaurant's menu source and the POS it uses.

The insights page says so, and notes that figures from an external menu or POS are not included until it is connected.

### What is stored for integrations

- `restaurants.menu_source`
- `external_menu_url`
- `external_pos_name`

These record what to integrate with. No integration is built yet.

### Rules for adding an integration

An integration must:

- tag its records with `source = EXTERNAL`;
- be switchable as its own service;
- never become a hard dependency of reporting or ordering.

Reporting reads orders whatever the menu source is. Ordering needs only the digital menu.
