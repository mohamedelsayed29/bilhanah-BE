# Bilhanah (بالهنا): next roadmap, easier to use and many more features

## Context

Phases 0–6 are finished: menu, billing and admin, ordering, ready alerts, Paymob, stand shop, analytics, the UI overhaul and the Arabesque theme. The only phase left from the old plan is **Phase 7, launch** (server, domain, email service, Paymob account, storage, monitoring), and it is waiting on accounts from you.

The user asked how the product can become much more powerful and much easier to use. I checked the code to see what exists today. Most of the expected restaurant features are still missing:

- add-ons and options
- dietary tags
- staff accounts
- a kitchen screen
- delivery
- discount codes
- reviews
- calling the waiter
- menus by time of day
- bulk import
- receipt printing
- WhatsApp notifications
- loyalty
- reservations
- more than one branch
- custom domains
- hourly analytics
- owner alerts outside the dashboard

The backend `promotions` and `users` modules and the dashboard `admin/promotions` folder are empty placeholders, waiting for this work.

**Recommendation:** launch (Phase 7) with what exists now, then ship the phases below one at a time. Real restaurants will tell us which phase matters most. Each phase is sized to be built, tested and pushed on its own, the way Phases 5 and 6 were.

**Plan fit:** each feature is tied to a plan. More reasons to upgrade means more EGP 350 and EGP 500 subscriptions.

---

## Phase 8: Effortless setup (the owner is live in 10 minutes)

The biggest friction today is typing a whole menu by hand, in two languages.

- **Menu from a photo.** The owner photographs a paper menu, and Claude vision (via the API) extracts categories, items, sizes and prices into a draft. The owner reviews and fixes the draft, then publishes it.
- **Import from Excel or CSV.** Comes with a downloadable template. A preview shows errors row by row before anything is saved.
- **Automatic Arabic ↔ English translation** of item names and descriptions, with one "translate everything" button. The owner can still edit every field.
- **Starter menus.** Ready-made menus for koshary, café, grill, pizza, juice and bakery, with photos and typical prices. The owner edits them instead of starting from nothing.
- **Smarter onboarding.** The wizard gains logo, colour, theme and first items, and ends on "print your QR code". The existing checklist in `OverviewPage.tsx` is extended.
- **Faster editing:**
  - duplicate an item
  - edit prices inline
  - raise all prices by X%
  - undo the last change
  - drafts stay unpublished until "Publish"
- **Help everywhere.** Short Arabic help notes on each page, a WhatsApp support button, and a guided first-visit tour.

Touches:
- BE `src/modules/menus`, plus a new `src/modules/menu-import`, with jobs on the worker queue.
- DFE `src/features/restaurant/menu`, `onboarding`.
- Contracts `menus.ts`.

Available on all plans.

---

## Phase 9: Richer menu (diners understand what they are ordering)

- **Add-ons and option groups**, each with a minimum and maximum choice. Examples: extra cheese +15, spice level, sauce choice (required, pick 1). Prices are checked again on the server, as sizes already are.
- **Dietary tags and allergens:** spicy, vegetarian, vegan, gluten-free, contains nuts, new, best seller, chef's pick. Diners can filter the menu by tag.
- **Menus by time of day.** A breakfast category is shown only from 8 to 12; there is a Ramadan iftar/suhoor menu; items can be scheduled by weekday.
- **Combos and meal deals:** a fixed set of items at a discounted price.
- **Item details:** calories, preparation time, several photos per item, and short videos.
- **Sold-out items auto-reset** each morning (optional).
- **More themes.** The next batch from `docs/THEMES.md`: Khayameya, Old Cairo, Fanous/Ramadan, Street food, Elegant. Premium themes could be limited to the Full Experience plan.

Touches:
- New Prisma models: `ModifierGroup`, `Modifier`, `MenuItemTag`, `CategorySchedule`.
- `OrderItem` snapshots the chosen add-ons.
- CFE `DishSheet.tsx`, `use-cart.ts`.

Available on all plans. Add-ons in orders apply to ORDERS and above.

---

## Phase 10: Running the restaurant floor (ORDERS and Full Experience)

- **Staff accounts with roles:**

  | Role | Can do |
  |---|---|
  | Owner | Everything |
  | Manager | Menu and orders, no billing |
  | Cashier | Orders board |
  | Kitchen | Kitchen screen only |
  | Waiter | Their tables and waiter calls |

  Staff are invited by email or phone, and can log in with a short PIN on a shared tablet. This fills the empty `users` module and adds roles beyond OWNER and ADMIN.
- **Kitchen display screen (KDS).** A full-screen, high-contrast tablet view that shows how long each order has waited (colour changes as it gets late) and can be bumped with one tap. Optional stations (grill, drinks) route each item to its own screen.
- **Call the waiter.** A button on the table's menu: "call waiter", "bring the bill", "water". Requests appear live on the dashboard, with sound.
- **Receipt and kitchen printing.** Thermal printer slips (58/80 mm) printed from the browser, with optional auto-print for new orders.
- **Owner alerts outside the dashboard.** Web Push to the owner's phone, plus an optional WhatsApp or SMS for each new order, so they never miss one.
- **Table sessions.** Several diners at one table add to the same open order, and the table can "ask for the bill".
- **Order history filters and CSV export.**

Touches:
- BE `UserRole` enum, a new `StaffMember` model, `RolesGuard`, the `realtime` module.
- DFE: new `staff/`, `kitchen/` and `waiter-calls/` features.

ORDERS plan: KDS and waiter calls. Full Experience plan: stations, auto-print, WhatsApp alerts.

---

## Phase 11: Selling more (revenue for restaurants)

- **Delivery orders.** Delivery zones with a fee and minimum order per zone, the diner's address and location on a map, and delivery status steps. This adds a `DELIVERY` value to `OrderType`.
- **Online payment for food.** Card, wallet or InstaPay through Paymob, with a payout setup per restaurant. Cash stays the default. This reuses the existing Paymob integration (`src/infrastructure/paymob`).
- **Discount codes and offers.** Percent or fixed amount, minimum order, valid hours ("happy hour"), and a usage limit. Fills the empty `promotions` module.
- **Upselling.** "Goes well with…" suggestions in the dish sheet and cart, and a "popular" badge taken from real sales.
- **WhatsApp ordering and receipts.** The order summary is sent to the diner's WhatsApp, with status updates through the WhatsApp Business API. This needs a Meta business account.
- **Pre-order for later.** Pickup at a chosen time.

ORDERS plan: discount codes and upselling. Full Experience plan: delivery, online food payment and WhatsApp. These are the strongest reasons to upgrade.

---

## Phase 12: Diners who come back

- **Light diner profiles.** The phone number is remembered on the device, with "reorder my last order" and an order history. Optional sign-in by OTP.
- **Loyalty.** Stamp cards ("6th coffee free") or points per EGP spent, set by the owner.
- **Reviews and feedback.** After an order is completed: rate it 1–5 stars, add a comment, and attach a photo. Low ratings go privately to the owner; happy diners are nudged toward Google Maps.
- **Reservations.** Pick a date, time and party size; the owner confirms. Includes WhatsApp reminders.
- **Marketing list.** Diners who opt in can be messaged about offers, by WhatsApp or email, with consent kept under PDPL.

Full Experience plan.

---

## Phase 13: Growing restaurants and chains

- **Multiple branches per owner.** One menu shared across branches, with prices and availability overridable per branch, a branch picker, and a combined dashboard. This removes the one-restaurant-per-owner limit (`Restaurant.ownerId @unique`).
- **Custom domain** (`menu.myrestaurant.com`) with automatic HTTPS through Caddy on-demand TLS.
- **Deeper analytics:**
  - busiest hours and weekdays (heatmap)
  - sales by category and by dish
  - menu items people look at but don't order
  - QR scans per table
  - compare branches
  - export to CSV or PDF
  - a weekly email summary to the owner
- **AI insights.** A monthly note in Arabic, for example: "Your fattah sells 40% more on Fridays, put it at the top", plus price suggestions.
- **Public API and webhooks** for POS and accounting integrations.

This could be a new **Chains** plan, priced per branch.

---

## Phase 14: Platform and admin power (for you and Mohamed)

- **Admin CRM.** Notes for each restaurant, health score (active, at risk, inactive), and follow-ups for trials about to expire.
- **Diner promotions in admin.** Platform-wide coupon codes for plans ("first month 50% off"), plus referrals: "invite a restaurant, get a free month".
- **Impersonation (view as owner)** for support, recorded in the audit log.
- **In-app announcements** and a changelog.
- **Status page and automatic database backups.** This builds on Phase 7.

---

## Suggested order

1. **Phase 7: launch.** Done, apart from your accounts.
2. **Phase 8: easy setup.** Biggest effect on signups.
3. **Phase 9: richer menu.** Add-ons are the most requested feature in Egyptian restaurants.
4. **Phase 10: staff and kitchen.** Makes ORDERS worth paying for.
5. **Phase 11: delivery and discounts.** Makes Full Experience worth paying for.
6. **Phases 12 → 13 → 14** as the customer base grows.

## Verification (each phase, as before)

- BE unit and e2e tests for each new module. Tenant isolation (owner A cannot touch B's data), plan gating, and staff role permissions get explicit tests.
- Playwright in Arabic and English with axe AA checks. The layout audit (`audit.mjs`) shows zero clipped or overlapping text at 320–1280 px.
- A live run in Chrome of each phase's main journey. Examples:
  - photo → menu draft → publish
  - add-on order → kitchen screen bump → diner tracking
  - delivery order → online payment → webhook
- Commit, push to Mohamed's 3 repos, and update the credentials PDF when new logins (staff PIN) are added.
