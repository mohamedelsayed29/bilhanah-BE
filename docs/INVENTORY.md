# Inventory, recipes and cost management

How Bilhanah tracks ingredients, stock per branch, purchases, waste, stock
counts and transfers, deducts stock automatically from orders through
recipes, and turns all of it into food cost and menu profitability. The owner
decides how it behaves (settings) and who may do what (permissions).

Plans: **Menu & Orders (ORDERS)** and **Full Experience (ADVANCED)**
(`PLAN_FEATURES[plan].inventory` in `packages/contracts/src/plans.ts`, the one
place to change it). Without it (or without access: expired, suspended),
inventory routes answer 409 `INVENTORY_UNAVAILABLE` and orders deduct nothing;
data is kept. Owners read the plan from their restaurant's `access.features`;
staff screens from `GET /v1/kitchen/context` (`features`: the plan's features
while the restaurant has access, all off otherwise, from the same
`effectiveFeatures` rule the routes use), so the dashboard offers the section
without calling an inventory route to find out.

Code: `src/modules/inventory/` (`inventory-math.ts` is the pure arithmetic,
`inventory-engine.service.ts` the ledger and auto sold-out,
`inventory-orders.service.ts` the order hooks). Contracts:
`packages/contracts/src/inventory.ts`. Migrations `20261113000000_inventory`,
`20261113100000_inventory_settings` and `20261113200000_inventory_unit_names`.

## Concepts

| Concept | Scope | What it is |
| --- | --- | --- |
| Ingredient | restaurant | Something stocked or used: rice, oil, cups. `RAW` (bought) or `PREPARED` (made in-house from a recipe, e.g. tomato sauce). Optional category (free text), standard cost, preferred supplier and default reorder point. |
| Unit | ingredient | Every quantity is stored in the ingredient's **base unit**: grams (MASS), millilitres (VOLUME) or pieces (COUNT). Purchase units convert to it: kg = 1000 g, "25 kg sack" = 25000 g, "carton" = 24 pcs. |
| Stock | branch × ingredient | On hand (base units), weighted average unit cost, reorder point and par level. |
| Movement | branch × ingredient | Immutable ledger entry; the only way stock changes. |
| Supplier | restaurant | Who sells an ingredient; an ingredient may name a preferred supplier. |
| Purchase | branch | Goods received from a supplier (an invoice). DRAFT → RECEIVED (posts stock) → VOID (reverses). |
| Recipe | dish size (variant) or prepared ingredient | Ingredient lines with quantity and waste %. |
| Waste | branch | Stock thrown away or given away, with one of the restaurant's waste reasons. |
| Stock count | branch | A stocktake: expected quantities are snapshotted, counted quantities entered, posting books the variance (after approval when required). |
| Transfer | branch → branch | Stock moved between branches at the sender's average cost. |

### Quantities and money

- Quantities: `DECIMAL(14,3)` in base units (0.001 g precision).
- Unit costs: piastres per base unit, `DECIMAL(14,4)` (EGP 25/kg = 2.5 piastres/g).
- Values (quantity × cost): `DECIMAL(16,2)` piastres; reports round to whole piastres.
- In the API, decimals travel as JSON numbers; inputs accept at most 3 decimals
  for quantities, 4 for unit costs and prices, 2 for totals and percentages.
- Arithmetic uses `Prisma.Decimal`, never floats.
- Unit names travel in both languages: purchase and waste lines copy the unit's
  `unitNameAr` and `unitNameEn` when they are made (so renaming or removing the
  unit later keeps them), and reorder suggestions give the first purchase unit's
  two names. English is null for a unit the owner named only in Arabic; screens
  then show the Arabic name. Null names on a line mean the base unit.

### Costing method: weighted average per branch

- Inflows at a known cost (purchase, transfer in):
  `avg = (onHand × avg + qty × cost) / (onHand + qty)` while `onHand > 0`;
  when `onHand ≤ 0` (or no average yet), `avg = cost`.
- Returns (sale reversal at the cost it left with, positive count variance at
  the current average) blend the same way but never create an average where
  the branch has none.
- A void takes the purchase back at its own cost and **unwinds** the average
  (`(onHand × avg − qty × cost) / (onHand − qty)`, never below 0); when nothing
  would remain the average stays.
- Outflows (sales, waste, transfer out, negative variance) are valued at the
  current average, which does not change.
- No average yet (never received at this branch): the ingredient's
  `standardCost` (owner-entered, piastres per base unit) is used, else 0.
- Stock may go negative under `ALLOW_NEGATIVE`/`WARN` (a sale is never blocked
  by the ledger); reports flag it (`negativeItems`, status `OUT`).

### Prepared ingredients

A `PREPARED` ingredient has a recipe and a `yieldQuantity` (base units the recipe makes).
It holds no stock of its own: using it (sales, waste) **explodes** into its
components, scaled by `used / yieldQuantity`; it cannot be bought, counted or
transferred (400 `INVENTORY_NOT_RAW`). Its cost is the sum of its components'
cost divided by its yield. Nesting up to 3 levels (a prepared ingredient may
use prepared ingredients two more levels down); deeper is refused (400
`RECIPE_TOO_DEEP`), cycles too (400 `RECIPE_CYCLE`, `details.path`). Recipe
changes of one restaurant are serialised (advisory lock), so two edits cannot
form a cycle together. A prepared ingredient without a recipe contributes
nothing and marks costs `incomplete`.

### Recipes

- Each dish size (`MenuItemVariant`) may have a recipe; a dish with several sizes has one per size.
- A line: ingredient, quantity in base units as served, waste % (0–90, trimming and loss):
  **usage = quantity / (1 − waste% / 100)**, so "100 g served, 10% trim" uses 111.111 g.
- `PUT` replaces the whole recipe; an empty list removes it. An ingredient
  appears once per recipe (400 `INVENTORY_DUPLICATE_LINE`); archived ones cannot be added.
- Recipe cost at a branch = Σ usage × that branch's unit cost (see valuation basis).
- Ingredient kind and unit type are locked once it has movements, documents or
  is used in a recipe (409 `INVENTORY_INGREDIENT_LOCKED`); such an ingredient is
  archived (`isActive: false`) rather than deleted (409 `INVENTORY_INGREDIENT_IN_USE`).
  Every ingredient response says so: `locked`, and `lockReason` `HISTORY`
  (stock movements, or a line on a purchase, waste entry, count or transfer: it
  never unlocks) before `RECIPES` (used in a recipe: removing it from every
  recipe unlocks it); null when unlocked. The flag and both refusals come from
  one query, so they cannot disagree.

## Settings (owner-configurable)

`GET /v1/inventory/settings` (view or manage), `PUT` (manage). PUT takes any of
the fields; the others keep their value. Stored per restaurant
(`inventory_settings`), with per-branch overrides (`inventory_branch_settings`).

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Orders deduct stock and auto sold-out acts. Off: the catalogue, purchases, waste, counts and reports still work; turning it off lifts the sold-out marks inventory set. |
| `deductOn` | `ACCEPTED` | `ACCEPTED`, `READY` or `COMPLETED`: an order's stock is deducted when it reaches this status **or any later one** (an order that jumps ACCEPTED → READY, or completes by cascade from the kitchen display, is deducted once). |
| `stockPolicy` | `ALLOW_NEGATIVE` | At placement, when the branch's on-hand stock cannot cover the order's recipes (summed over its lines): `ALLOW_NEGATIVE` places it; `WARN` places it and flags it (`OwnerOrder.lowStockItemIds`, the low-stock report); `BLOCK_ORDERS` refuses it with 409 `INSUFFICIENT_STOCK` (`details.menuItemIds`). Applies to public order placement and shared-table submissions. Never without inventory (`enabled`, plan) or for dishes without a recipe. It is a check, not a reservation: orders accepted but not yet deducted (`deductOn` READY/COMPLETED) are not held back. |
| `autoSoldOut` | `true` | See auto sold-out. |
| `autoRestore` | `true` | Restocking lifts the sold-out marks inventory set. Off: they stay until someone changes availability by hand. |
| `valuationBasis` | `AVERAGE` | The unit cost costing, recipe costs, stock values, valuation and reorder estimates use: `AVERAGE` (branch average, else standard cost) or `STANDARD` (standard cost, else the average). The ledger itself (movements, order line costs, food cost report) always uses the weighted average. |
| `wasteReasons` | expired, spoiled, dropped, overcooked, staff meal, complimentary, other | The restaurant's list, `{ code, nameAr, nameEn }`, 1–20, codes `A-Z0-9_` (upper-cased). Waste must use one of them (400 `INVENTORY_WASTE_REASON_UNKNOWN`); each entry copies the names, so editing the list keeps history. |
| `requireCountApproval` | `false` | Posting a count with a line off by more than the threshold needs `inventory.approve` (see stock counts). |
| `countVarianceThresholdPercent` | `10` | `|counted − expected| / expected × 100`; anything counted where nothing was expected is above it. |
| `branches[]` | none | Per branch: `stockPolicy`, `autoSoldOut`, `autoRestore` (null follows the restaurant). PUT replaces the overrides of the branches it lists; all-null removes one. GET returns every visible branch with its overrides and `effective` values. |

Reorder points: each stock row's `reorderPoint` (per branch, `PATCH /stock/:id`);
where a branch has none, the ingredient's `defaultReorderPoint`
(`reorderPointIsDefault: true` in the stock list).

## Automatic deduction from orders

| Event | Effect |
| --- | --- |
| Order reaches `deductOn` (or a later status) | For every line not cancelled: explode its size's recipe × quantity, post `SALE` movements, store the line's cost (whole line) on `order_items.cost_piastres`, stamp `orders.stock_deducted_at`. |
| Order `→ CANCELLED` | Post `SALE_REVERSAL` for every line deducted and not yet reversed (back at the same cost). Before the deduction point there is nothing to reverse. |
| One dish `→ CANCELLED` on the kitchen display | Reverse that line if it was deducted; a dish cancelled before the deduction point is never deducted. |
| Order `REJECTED` (never accepted) | Nothing was deducted. |

- Runs in the same transaction as the status change, inside a savepoint: an
  inventory error is rolled back and logged and the order's change still
  commits (inventory never blocks or fails a status change).
- Idempotent: `orders.stock_deducted_at` (compare-and-swap) makes deduction
  happen once whatever path the order takes, and each movement has a unique
  `source_key` (`sale:{orderItemId}:{ingredientId}` /
  `sale-reversal:{orderItemId}:{ingredientId}`), so retries never double-count.
- Order lines record their size (`order_items.variant_id`, set at placement);
  lines without a recipe deduct nothing (`cost_piastres` null: "no recipe").
- Only when `enabled` and the plan includes inventory. Reversals run whenever
  there is something to reverse (they only undo what was deducted).

## Auto sold-out

With `autoSoldOut` on (and `enabled`), when an outflow leaves an ingredient at
≤ 0 at a branch, every dish whose **every** size needs that ingredient (after
exploding prepared ingredients; dishes with a size without a recipe are left
out) is marked sold out at that branch: a `branch_menu_items` override with
`is_available = false, sold_out_by_inventory = true`. With `autoRestore`, an
inflow re-checks the dishes inventory marked: a mark is lifted once no
ingredient that every size needs is at ≤ 0 (a refinement of "all ingredients
above 0": a size-specific ingredient never blocks the dish).

Manual marks are never touched: a dish with its own availability mark at the
branch is not marked, and any manual availability change
(`PUT /branches/:id/menu/items/:itemId` with `available`) clears the flag, so
restocking never undoes it. Copying a branch menu does not copy inventory's
marks. Switching auto sold-out off (or inventory off) lifts the marks it set.
Every change bumps `menuVersion`, so the public menu updates at once. The
branch menu shows `override.soldOutByInventory`.

## Permissions

| Permission | Allows | Default roles |
| --- | --- | --- |
| `inventory.view` | Stock, movements, ingredients, recipes, suppliers, purchases, waste, counts, reorder and low-stock lists (quantities) | OWNER, MANAGER, KITCHEN |
| `inventory.waste` | Record waste, enter counted quantities on an open count | OWNER, MANAGER, KITCHEN |
| `inventory.operate` | Create, receive and void purchases, create, post and cancel counts, transfers out of their branch | OWNER, MANAGER |
| `inventory.manage` | Ingredients, units, recipes, suppliers, reorder levels, settings | OWNER |
| `inventory.costs` | Unit costs, values, purchase prices, costing, valuation, food cost and menu engineering | OWNER, MANAGER |
| `inventory.approve` | Approve or send back counts waiting for approval | OWNER |

Every inventory permission is grantable to every staff role
(`GRANTABLE_PERMISSIONS`: MANAGER, CASHIER, WAITER, KITCHEN), on top of the
defaults; as for every grant, a manager can give only what they hold.
Without `inventory.costs`, cost fields are null in every response.
Branch-tied staff only see and act on their branch (`BranchScopeService`:
another restaurant's ids 404, another branch of their restaurant 403);
documents of another branch look unknown (404). A transfer may go *to* any
branch of the restaurant, but only *from* a branch in the caller's scope (a
branch-tied manager sends from their own branch only; another branch 403, another
restaurant's 404). Since `/v1/branches`, the kitchen context and the inventory
settings show such a manager only their branch, `GET /transfer-destinations`
lists where they may send: the restaurant's other active branches, as `{ id,
name, slug }` and nothing else.

## API (all under `/v1/inventory`, Bearer)

| Route | Permission | Notes |
| --- | --- | --- |
| `GET/PUT /settings` | view or manage / manage | See settings |
| `GET /ingredients?branchId=&includeInactive=`, `POST`, `PATCH /:id`, `DELETE /:id` | view / manage | `currentCost` at the branch (average for raw, recipe cost for prepared) when allowed; `usedIn` counts recipes using it; `locked` / `lockReason` (see recipes) |
| `PUT /ingredients/:id/units` | manage | Purchase units `{ nameAr, nameEn?, factor }`; replaced, matched by name (ids kept) |
| `PUT /ingredients/:id/recipe` | manage | Prepared ingredients: `{ yieldQuantity, lines }` |
| `GET/PUT /recipes/variants/:variantId?branchId=` | view / manage | A dish size's recipe with usage and (when allowed) line costs, and `costs` per branch with its price and food cost % |
| `GET /costing?branchId=` | costs | Every dish size: recipe cost, price (branch price aware), food cost %, margin, `hasRecipe`, `incomplete` |
| `GET /dishes?branchId=` | view or waste | Every dish size (menu order): item, size and category names (Arabic and English; size names null for one-size dishes), `hasRecipe`, and its recipe lines (ingredient, kind, base unit, quantity, waste %, usage). Never a cost or a price, whoever asks: the recipe view without `inventory.costs` and the whole-dish waste picker use it |
| `GET/POST /suppliers`, `PATCH/DELETE /suppliers/:id` | view / manage | Delete only without purchases (409 `INVENTORY_SUPPLIER_IN_USE`), else archive |
| `GET /stock?branchId=` | view | Raw ingredients: on hand, unit, avg cost, value, reorder point (own or default), par level, status OK/LOW/OUT |
| `PATCH /stock/:ingredientId?branchId=` | manage | `{ reorderPoint, parLevel }` |
| `GET /movements?branchId=&ingredientId=&type=&from=&to=&page=` | view | Ledger, newest first, with its source document |
| `GET/POST /purchases`, `GET/PATCH /purchases/:id`, `POST /purchases/:id/receive`, `POST /purchases/:id/void` | view / operate | Lines in any of the ingredient's units with a unit price or a line total; `receive: true` on POST receives at once; void needs a reason (a draft can be voided too) |
| `GET/POST /waste` | view / waste | Lines: an ingredient (any unit; prepared ones explode) or whole dishes `{ variantId, quantity }` (their recipe; 400 `INVENTORY_NO_RECIPE` without one) |
| `GET/POST /counts`, `GET/PATCH /counts/:id`, `POST /counts/:id/post`, `POST /counts/:id/cancel` | view / operate (create, post, cancel) / waste or operate (enter) | One open or pending count per branch (409 `INVENTORY_COUNT_ALREADY_OPEN`); created for listed ingredients, a category, or every active raw one |
| `POST /counts/:id/approve`, `POST /counts/:id/reject` | approve | `{ note? }`; reject sends it back to OPEN |
| `POST /transfers`, `GET /transfers` | operate | Posted in one step; `fromBranchId` must be in the caller's scope (defaults to theirs, or the main branch), `toBranchId` any other branch of the restaurant |
| `GET /transfer-destinations?branchId=` | operate | The other active branches a transfer from the branch (checked against the caller's scope; default theirs, or the main branch) may go to: `[{ id, name, slug }]`, main first |
| `GET /reports/valuation?branchId=` | costs | Stock value by category (positive stock; negative counted, not valued) |
| `GET /reports/reorder?branchId=` | view | At or below the reorder point: suggested quantity up to par (or the reorder point), in the first purchase unit rounded up, grouped by preferred supplier, estimated cost when allowed |
| `GET /reports/low-stock?branchId=&days=` | view | Ingredients LOW/OUT, and orders the WARN policy flagged over the last days |
| `GET /reports/food-cost?branchId=&from=&to=` | costs | Revenue, theoretical cost (sales), waste, count variance, purchases, theoretical vs actual food cost % (total and per branch) |
| `GET /reports/menu-engineering?branchId=&days=` | costs | Per dish: sold, revenue, cost, margin; Star / Plowhorse / Puzzle / Dog |

### Stock counts

Creating a count snapshots each line's expected quantity (on hand then).
Counted quantities are entered while it is OPEN. Posting books
`counted − expected` for every counted line as `COUNT_VARIANCE` (lines left
blank are skipped), so sales recorded while counting do not distort it. With
`requireCountApproval`, a post by someone without `inventory.approve` while a
line is above the threshold moves the count to `PENDING_APPROVAL` (no stock
change, `submittedBy`); an approver approves (books it) or rejects (back to
OPEN, with a note). Lines report `overThreshold`.

### Menu engineering

Over the period, per dish (orders not rejected or cancelled, dishes
not cancelled): quantity sold, revenue, cost of sales (from
`order_items.cost_piastres`), contribution margin per unit. Popularity is "high"
when the dish's share of items sold is ≥ 70% of an equal share (1 / number of
dishes); margin is "high" when its unit margin is ≥ the sales-weighted average
margin. Star = high/high, Plowhorse = high popularity / low margin, Puzzle =
low popularity / high margin, Dog = low/low. Dishes without recipe cost are
listed with `class: null` and left out of the classification. Only dishes sold
in the period are listed.

### Food cost report

For a branch (or every branch, with a row per branch) and a date range
(restaurant business days, at most 366):

- revenue: counted orders' subtotals (not rejected or cancelled), by business day;
- theoretical cost: `SALE − SALE_REVERSAL` movement value;
- waste cost; count variance (net, signed: negative is a loss, a gain offsets);
  purchases (received − voided);
- theoretical food cost % = theoretical / revenue; actual % = (theoretical + waste − net variance) / revenue.

## Concurrency and integrity

- Every posting locks the affected stock rows (`SELECT … FOR UPDATE`, branch
  then ingredient id order to avoid deadlocks; transfers lock both branches
  first), skips source keys already posted, updates the rows and inserts the
  movements in one transaction.
- Purchases, counts and voids use compare-and-swap on status (two receives at
  once post once; the other gets 409 `INVENTORY_PURCHASE_STATUS`).
- SQL CHECKs: positive factors and yields, waste % 0–90, non-negative prices and
  costs, exactly one recipe owner per line, no self-use, quantity ≠ 0 and the
  sign of each movement type, different branches on a transfer.
- Tenant isolation: every id from a request is checked against the caller's
  restaurant (and branch when tied to one).

## Demo data

`npm run seed:demo` gives `koshary-demo` inventory on, 25 Egyptian pantry
ingredients with purchase units and suppliers, a prepared tomato sauce, crispy
onions and garlic-vinegar dressing, recipes for every dish size, a week's
deliveries and some waste at both branches, and reorder levels.
