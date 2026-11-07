# Loyalty program

Each restaurant runs its own points program. Diners earn points on completed orders and spend them on rewards at checkout. This works at every branch and on every order type the restaurant allows.

- **Contracts:** `packages/contracts/src/loyalty.ts`
- **Backend:** `src/modules/loyalty/`

## When it runs

The program runs only while all of these hold:

- The `LOYALTY` service is on. It needs `QR_ORDERING` (docs/SERVICES.md).
- The plan includes ordering.
- The owner switched it on in `loyalty_settings.enabled`. It is off by default.

When any of these is missing:

- `GET /v1/public/restaurants/:subdomain/loyalty` answers `{ enabled: false }`.
- Orders are placed without loyalty.
- An order that asks for a reward gets 409 `LOYALTY_UNAVAILABLE`.

## Members and the member card

**Members.** A member belongs to one restaurant, keyed by `(restaurant, phone)`. The same phone at another restaurant is a separate member. Every query is scoped by `restaurant_id`.

**Joining.** A diner becomes a member in either of two ways:

- on their first order with a phone;
- with `POST /v1/public/restaurants/:subdomain/loyalty/join`.

**The card.** The checkout that created the membership receives a **member card**: a signed pass `"<member id>.<version>.<hmac>"`. The browser keeps it.

- Seeing the balance and redeeming need a valid card.
- Earning needs only the phone.
- Staff can issue a new card from the dashboard (`loyalty.adjust`). The new card is shown as a QR code and a link `/loyalty#card=…`. Issuing it bumps `pass_version`, so every older card stops working.
- There is no SMS step, so the card is what proves ownership.

## The ledger

Every change to a balance goes through `postLoyalty`. It does two things in one statement:

- updates `loyalty_members.balance`, which locks the member's row;
- writes a `loyalty_transactions` row with the kind, the signed points, the balance after, the reason, the order, the reward and the actor.

| Kind | When it is written |
| --- | --- |
| `EARN` | The order reached the completion state. |
| `EARN_REVERSAL` | The order was refunded and refunds reverse earned points. |
| `REDEEM` | A reward was applied at checkout. Its points are taken atomically, and never below zero. |
| `REDEEM_RETURN` | A cancelled, rejected or refunded order gives back the points spent on it (per the settings). |
| `EXPIRE` | The member had no activity for `expiry_days`. The hourly worker job writes it, and read paths check it too. |
| `ADJUST` | Staff added or removed points by hand, with a reason. Never below zero. |

## Earning and reversals: `syncOrder`

An order fixes `loyalty_points_to_earn` when it is placed. This is the figure checkout showed.

After any status or payment change, `LoyaltyCore.syncOrder(tx, orderId)` runs inside that change's transaction:

1. It works out where the points should stand (`loyaltyTargets`).
2. It switches the order's `loyalty_earned` and `loyalty_spent_held` flags with a compare-and-swap.

Because of the compare-and-swap, an order never earns twice, even when the request is repeated or concurrent.

### Completion state

- `COMPLETED`: the order was served or handed over.
- `PAID`: the order is completed and its bill is marked paid.

### Refunds

Marking a paid bill unpaid is a refund. It sets `orders.refunded_at`, and paying the bill again clears it.

### Reversal settings

- `cancel_returns_redeemed`
- `refund_reverses_earned`
- `refund_returns_redeemed`

## Rewards

| Type | What it does |
| --- | --- |
| `FIXED_DISCOUNT` | Takes a fixed amount off the bill. |
| `PERCENT_DISCOUNT` | Takes a share off the bill, with an optional cap. |
| `FREE_PRODUCT` | Makes one unit of a dish (or one size) free when it is in the order. |
| `FREE_ADDON` | Like a free product, but the order needs another paid dish. |

### Limits

- **Per reward:**
  - points cost;
  - minimum order;
  - uses per member;
  - minimum tier.
- **Program-wide:**
  - `min_redeem_points`;
  - `max_discount_percent` of the subtotal;
  - one reward per order.

The server always checks eligibility again, both in the quote and when the order is placed.

### Discount and the bill

- `orders.discount_piastres` holds the reward's discount.
- The bill is `subtotal - discount`.
- The cash drawer, the floor's unpaid total and the revenue reports all use the bill.

## Tiers

Tiers are optional (`tiers_enabled`).

- A member reaches a tier by `lifetime_points`, which counts earnings minus reversals.
- A tier multiplies the points a member earns, from 100 % (1×) to 500 % (5×).

## Endpoints

### Diners

- `GET /v1/public/restaurants/:subdomain/loyalty`
- `POST /v1/public/restaurants/:subdomain/loyalty/me` (the card goes in the body)
- `POST /v1/public/restaurants/:subdomain/loyalty/join`
- `POST /v1/public/restaurants/:subdomain/orders/quote`

`placeOrderSchema.loyalty` carries `{ pass, rewardId }`.

### Restaurant

All restaurant endpoints are under `/v1/loyalty`.

| Endpoint | Permission |
| --- | --- |
| `settings`, `tiers`, `rewards` | Read: `loyalty.view` or `loyalty.settings`. Change: `loyalty.settings`. |
| `members`, `members/:id`, `analytics` | `loyalty.view` |
| `members/:id/adjustments`, `members/:id/card` | `loyalty.adjust` |

## Analytics

These are the program's success measures:

- **Repeat customer rate:** customers known by phone who ordered in the period and have two or more completed orders.
- **Redemption rate:** points redeemed divided by points issued.
- **Revenue from returning customers:** the bills of completed orders after a customer's first one.
