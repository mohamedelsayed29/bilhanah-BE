import type { BranchItemOverride } from '@bilhanah/contracts';

// How a branch's overrides change the shared menu. Pure, so the owner's branch
// menu, the public menu and order pricing all agree (and it is unit-tested).

export type ItemOverrideRow = { itemId: string; isAvailable: boolean | null; isHidden: boolean };
export type PriceOverrideRow = { variantId: string; pricePiastres: number };

export type BranchOverrides = {
  items: ReadonlyMap<string, ItemOverrideRow>;
  prices: ReadonlyMap<string, number>;
};

export const NO_OVERRIDES: BranchOverrides = { items: new Map(), prices: new Map() };

export function toOverrides(items: readonly ItemOverrideRow[], prices: readonly PriceOverrideRow[]): BranchOverrides {
  return {
    items: new Map(items.map((row) => [row.itemId, row])),
    prices: new Map(prices.map((row) => [row.variantId, row.pricePiastres])),
  };
}

type PricedVariant = { id: string; pricePiastres: number };
type SharedItem<Variant extends PricedVariant = PricedVariant> = { id: string; isAvailable: boolean; isVisible: boolean; variants: readonly Variant[] };

/** What the branch changed about this dish, in the shape the dashboard edits. */
export function itemOverride(item: SharedItem, overrides: BranchOverrides): BranchItemOverride {
  const row = overrides.items.get(item.id);
  const prices: Record<string, number> = {};
  for (const variant of item.variants) {
    const price = overrides.prices.get(variant.id);
    if (price !== undefined) prices[variant.id] = price;
  }
  return { available: row?.isAvailable ?? null, hidden: row?.isHidden ?? false, prices };
}

/**
 * The dish as the branch's diners see it. Hidden at the branch or on the
 * shared menu: not visible. Sold out: the branch's own mark when it has one,
 * otherwise the shared one. Prices: the branch's where set.
 */
export function effectiveItem<Variant extends PricedVariant>(
  item: SharedItem<Variant>,
  overrides: BranchOverrides,
): { available: boolean; visible: boolean; variants: Variant[] } {
  const row = overrides.items.get(item.id);
  return {
    visible: item.isVisible && !row?.isHidden,
    available: row?.isAvailable ?? item.isAvailable,
    variants: item.variants.map((variant) => ({ ...variant, pricePiastres: overrides.prices.get(variant.id) ?? variant.pricePiastres })),
  };
}

/** An override equal to "follow the shared menu" is deleted rather than stored. */
export function isEmptyItemOverride(row: { isAvailable: boolean | null; isHidden: boolean }): boolean {
  return row.isAvailable === null && !row.isHidden;
}
