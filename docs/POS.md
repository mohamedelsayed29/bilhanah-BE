# Point of Sale (POS)

The POS extends Bilhanah. It does not replace any part of it: POS orders are ordinary `orders` rows, priced by the same `OrdersService.priceLines`. They follow the same lifecycle and reach the same order board, kitchen display, cash drawer and reports.

## What already exists and is reused

| Need | Existing piece |
| --- | --- |
| Menu, sizes, branch prices and availability | `menus`, `branches/branch-menu` |
| Orders, statuses and idempotency | `orders` (`PLACED → ACCEPTED → PREPARING → READY → COMPLETED`, `REJECTED`, `CANCELLED`) and `ORDER_TRANSITIONS` |
| Kitchen display | `kitchen-display` (stations, item statuses) |
| Tables, sessions, transfers and merges | `tables`, `table-sessions`, `orders.transfer`, `table-groups` |
| Payments | `orders.paidAt` / `paymentMethod` (CASH, CARD, WALLET, OTHER) and `setPaid` (unpaid again = refund, `payments.refund`) |
| Cashier shifts and reconciliation | `cash` module, which has everything below |
| Roles and permissions | `contracts/permissions.ts` (`orders.create` was reserved for staff ordering) |
| Background jobs | BullMQ (`infrastructure/queues`) and the worker |
| Audit log | `audit` |
| Admin console | `admin` module and `bilhanah-dashboard-FE` |
| Installable app | `pwa` module (manifest) |
| Loyalty discounts | `loyalty` |

The cash module already provides:

- registers;
- open and close shifts, with expected, counted and difference;
- cash in and out;
- approvals;
- corrections;
- immutability after closing.

The POS uses these shifts as they are, so there is no second shift system.

## Tasks

| # | Task | Status |
| --- | --- | --- |
| 1 | Activation and access: admin switch and plans, per-restaurant access and modes, owner wizard, settings, permissions | done |
| 2 | POS orders: dine-in and takeaway, server-side bill, discounts within limits, idempotency | done |
| 3 | Payments: split and partial, cash with change, declined cards, refunds with reasons, cash drawer | done |
| 4 | Terminal (frontend): touch grid, cart, tables, payment, open orders, full screen | done |
| 5 | Devices and receipts: register, use, revoke; 80 mm browser printing | done |
| 6 | Integration framework: adapters, sealed secrets, mappings, sync jobs with retries, signed webhooks; generic webhook provider | done |
| 7 | Reports and admin: sales by channel, method and cashier, collected vs outstanding, shifts; health and audit | done |
| 8 | Offline mode | separate phase, not built |

## Activation (task 1)

`pos_platform_settings` is a single row:

- whether the POS is offered at all;
- the plans it is offered on.

`pos_accounts` has one row per restaurant.

| Field | Meaning |
| --- | --- |
| `access` | `ENABLED` (default), `DISABLED` or `SUSPENDED`. Set by the admin. |
| `allowed_modes` | Set by the admin. Defaults to Bilhanah POS and external. |
| `mode` | Chosen by the owner. |
| `activated_at`, `setup_completed_at` | Activation and setup steps. |
| Settings | Tax, service charge, payment methods, receipt, cashier discount limit. |

### Status, worked out in this order

| Status | When |
| --- | --- |
| `DISABLED` | The POS is off platform-wide, the plan does not include it, or the admin disabled it for the restaurant. |
| `SUSPENDED` | The admin suspended it. |
| `NOT_ACTIVATED` | The owner has not activated it. |
| `PENDING_SETUP` | Activated, but the settings were never saved. |
| `ACTIVE` | Everything is in place. |

### Who can do what

- The owner can activate only while the status is `NOT_ACTIVATED` or `PENDING_SETUP`.
- Everything else (the terminal and later tasks) requires `ACTIVE`, through `PosAccessService.requireActive`.
- The admin can enable, disable or suspend the POS for any restaurant without the owner, and every change is audited.

## POS orders (task 2)

`POST /v1/pos/orders` needs `pos.use`, `orders.create` and an Idempotency-Key header. `POST /v1/pos/orders/quote` takes the same body and returns the bill without placing anything.

- **Pricing.** The order is priced by `priceLines`, from the branch's menu, prices and availability. The client never sends a price.
- **Kitchen.** The order is created `ACCEPTED` (both events are recorded with the cashier), so it goes straight to the kitchen display. Inventory is deducted as for an accepted order.
- **Tables.** Dine-in needs a table of the caller's restaurant and branch. The order joins the table's open session.
- **The bill** (`posTotals`), stored on the order:
  - `discount` (with its reason);
  - `service_charge` (after the discount, dine-in only unless set otherwise);
  - `tax` (on the net plus the service charge, included in prices or added);
  - `total_piastres`.
- **Who uses the bill.** The cash drawer, the floor's unpaid total and refunds all use `total_piastres`. Sales reports keep using the subtotal less discounts: tax and service are not sales.
- **Discount limit.** A discount above `cashier_max_discount_percent` needs `pos.discount` (403 `POS_DISCOUNT_NOT_ALLOWED`).
- **Mode.** With mode `EXTERNAL` the Bilhanah terminal is off.
- **Channel.** `orders.channel` is `MENU` or `POS`, and `created_by_*` records who took the order.

The terminal reads the menu and tables through the existing endpoints:

- `GET /v1/menu` and the branch menu;
- `GET /v1/orders/floor`.

## Payments (task 3)

`order_payments` and `order_payment_refunds` record every order's payments: POS and QR menu, and marking paid from the board too.

- **Settling.** An order is settled (`paid_at`) when its payments cover `total_piastres`. It goes back to unpaid (with `refunded_at`) when refunds leave it short.
- **Locking.** Every operation locks the order first, so two payments never overpay it.
- **Cash.** Cash goes through the cashier's drawer (`cash_transactions`). If the POS requires an open shift, cash is refused without one.
- **Refunds.** A refund needs `payments.refund` and a reason, and is audited. It only records what was handed back; money at a card or wallet provider is returned there.
- **Card data.** Card numbers are refused in the reference field. Bilhanah never handles card data.

## Devices and receipts (task 5)

- **Registering.** `pos_devices` stores the sha256 of a device key. Registered "on this device", the key is returned once and kept by that browser. For another device, a one-time 8-character pairing code (stored hashed, valid 30 minutes) is returned instead; typed on the new device (`POST /v1/pos/devices/pair`, any account with `pos.use` at that restaurant and branch), it is exchanged for a fresh key.
- **Required.** Every terminal operation (quote, order, payments, refunds, receipt) needs `X-Pos-Device`: none gets 403 `POS_DEVICE_REQUIRED`; unknown, foreign, paused or revoked gets 403 `POS_DEVICE_REVOKED`. The order or payment records the device, and the device's last use.
- **Branch.** The device's branch is the terminal's: a branch-tied account on another branch's device, or an order or table of another branch, gets 403 `POS_DEVICE_WRONG_BRANCH`.
- **Limit.** `pos_accounts.max_devices` (set by the platform administrator, default 3, 1–100) caps ACTIVE and DISABLED devices; registration is serialised per restaurant and refused with 409 `POS_DEVICE_LIMIT`. Revoked devices free a place.
- **Status.** ACTIVE, DISABLED (paused; can resume) or REVOKED (final). The owner, a manager with `pos.settings`, or the administrator can change it.
- **Receipts.** `GET /v1/pos/orders/:id/receipt` builds the receipt from the server. The dashboard prints it with the browser, laid out for 80 mm paper.
- **Installing.** The dashboard has a web manifest, so it can be installed, with a shortcut straight to `/pos/terminal`.

## Security model

Four separate things decide whether a POS request runs, checked in this order on every request:

1. **Account** (`AccessTokenGuard`, `BranchScopeService.resolve`): signed in, ACTIVE, staff of this restaurant (or its owner), and the branch it may work at. Nothing the client sends about restaurant, branch or role is trusted.
2. **Entitlement** (`PosAccessService.requireActive`): an active, unexpired subscription whose plan the platform offers the POS with, administrator access ENABLED, and the owner's setup done. Otherwise 409 `POS_UNAVAILABLE` with the status.
3. **Device** (`PosTerminalService.onDevice`): an ACTIVE registered device of this restaurant, at the account's branch.
4. **Permission** (`RequirePermission` and the services): `pos.use`, plus `orders.create`, `payments.process`, `payments.refund`, `pos.discount` as each action needs. Cashiers get `pos.use`, `orders.create` and `payments.process` by default; refunds, discounts above the cashier limit, devices and settings are granted on purpose.

POS is not a role: cashiers are CASHIER accounts (one per person), and any staff role may be granted `pos.use`.

### PIN sign-in

- The owner or a manager sets a staff account's 4–6 digit PIN (`PUT /v1/kitchen-accounts/:id/pin`; stored with the password hasher, never shown again; null removes it).
- On a registered device, `GET /v1/pos/device` (device key only) lists who may sign in there: active staff of that restaurant and branch, holding `pos.use`, with a PIN. `POST /v1/pos/device/pin` signs in and starts a session that is not remembered (it ends with the browser session, at most a day).
- Five wrong PINs lock that account's PIN for 15 minutes (423 `POS_PIN_LOCKED`, with `until`); a new PIN from the owner lifts it. Requests are also rate-limited per IP. Every attempt is audited without the PIN.

### Audit

Logged (never passwords, PINs, keys or tokens): `pos.login`, `pos.logout`, `pos.pin.failed`, `pos.pin.locked`, `pos.pin.rejected`; `pos.device.registered`, `paired`, `pairing_issued`, `disabled`, `enabled`, `revoked`, `admin_*`; `pos.order.created` (with any discount), `pos.payment.recorded`, `pos.payment.refunded`; cash shifts (`cash.*`); staff and permission changes (staff log, including `staff.pin_changed`); `pos.access.*`, `pos.devices.limit_changed`, `pos.platform.updated`.

## External integrations (task 6)

### Adapters

`pos-sync/providers.ts` defines `PosProviderAdapter`:

- `testConnection`
- `fetchMenu`
- `syncMenu`
- `createOrder`
- `cancelOrder`
- `fetchOrderStatus`
- `verifyWebhook`
- `parseWebhook`

A capability the provider lacks throws `UnsupportedCapability`. The API reports it as 409 `POS_CAPABILITY_UNSUPPORTED`, never as a success.

### The webhook provider

The only adapter is `WEBHOOK`, for any POS that sends and receives webhooks.

- **Outbound.** Bilhanah POSTs `order.created` and `order.cancelled`.
  - Each request carries `X-Bilhanah-Signature: sha256=HMAC(outboundSecret, "<timestamp>.<body>")`, `X-Bilhanah-Timestamp` and `X-Bilhanah-Delivery`. The delivery id is the same on every retry, so the POS can drop duplicates.
  - A reply of `{ "externalId": "…" }` links the order to its id in the POS.
- **Inbound.** The POS posts `order.status` and `order.paid` to `/v1/public/pos/webhooks/:integrationId`.
  - The request is signed the same way with the inbound secret, and timestamps more than 5 minutes off are refused.
  - Each event id is processed once and logged in `pos_webhook_events`.
  - A forged request is refused with 401 and audited.

### Source of truth

| Entity | Source of truth |
| --- | --- |
| Menu | Bilhanah |
| Orders | Bilhanah → POS |
| Order status | POS → Bilhanah |
| Payments | POS → Bilhanah |

Updates from the POS are never sent back to it, so there are no sync loops.

### Sync jobs

`pos_sync_jobs` runs in the worker every 15 seconds.

- Jobs are claimed with `FOR UPDATE SKIP LOCKED`.
- Retries back off: 30 s, 1 min, 2 min… up to an hour, 6 attempts. A 429 waits for its `Retry-After`.
- A 4xx response, or running out of attempts, moves the job to `DEAD`, which can be retried by hand.
- An order counts as synced only after the provider replied 2xx.
- While an integration is paused, its jobs queue and wait.
- Disconnecting keeps everything.

### Secrets and mappings

- Secrets are sealed with `DATA_ENCRYPTION_KEY` (SecretBox). They are shown once, and can be rotated.
- `pos_mappings` stores branch, category, item, size and order ids, unique both ways per integration.
- In production the endpoint must be HTTPS and on a public host.

## Reports and admin (task 7)

`GET /v1/pos/reports` (from, to, branch, cashier, channel) needs `pos.settings` or `analytics.financial`. It returns:

- gross, discounts, net, tax and service, kept apart;
- billed, collected, refunded and outstanding;
- figures by channel, method and cashier;
- the cash shifts.

For administrators:

- `GET /v1/admin/pos/health`: statuses, devices, integrations, and jobs with the failing integrations.
- `GET /v1/admin/pos/audit`: every `pos.*` audit entry.

## Deployment

1. Run the migrations:
   - `20261121000000_pos_activation`
   - `20261122000000_pos_orders`
   - `20261123000000_pos_operations`
   - `20261124000000_pos_security` (device limit, paused devices, pairing codes, staff PINs)
2. Restart the API and the worker. The worker runs `pos-sync` on BullMQ, using the existing Redis.
3. Set `API_PUBLIC_URL`: webhook URLs are built from it.
4. Set `DATA_ENCRYPTION_KEY`, recommended so that rotating the JWT secret does not lose the integration secrets.
5. Turn the POS on in the admin console: Point of sale → Platform-wide.

## Known limits

- **Named providers.** No named provider (Foodics, MICROS, Odoo…) is implemented: their API documentation and credentials are not available. Each is a new adapter on the same interface. The generic webhook provider works with any POS that supports webhooks.
- **Offline.** There is no offline mode. The terminal shows when it is offline and sends nothing until it is back online.
- **Menu sync from a POS.** This needs a provider with a menu API.
- **Card payments.** They are recorded as taken by the restaurant's own card machine (method `CARD`, with its approval code). The POS does not talk to a card reader.
- **PIN sessions** last at most a day and end with the browser session; there is no idle timeout on the terminal yet.
- Printing is browser printing. Direct thermal (ESC/POS) printing needs a local bridge and is not built.
