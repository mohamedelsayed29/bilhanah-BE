import { effectiveItem, isEmptyItemOverride, itemOverride, NO_OVERRIDES, toOverrides } from './branch-menu.js';

const item = {
  id: 'item-1',
  isAvailable: true,
  isVisible: true,
  variants: [
    { id: 'small', nameAr: 'صغير', nameEn: 'Small', pricePiastres: 3000 },
    { id: 'large', nameAr: 'كبير', nameEn: 'Large', pricePiastres: 4500 },
  ],
};

describe('branch menu overrides', () => {
  it('follows the shared menu without overrides', () => {
    expect(effectiveItem(item, NO_OVERRIDES)).toEqual({ visible: true, available: true, variants: item.variants });
    expect(itemOverride(item, NO_OVERRIDES)).toEqual({ available: null, hidden: false, prices: {} });
  });

  it('applies own prices to the sizes that have one', () => {
    const overrides = toOverrides([], [{ variantId: 'large', pricePiastres: 5000 }, { variantId: 'other-item', pricePiastres: 1 }]);
    expect(effectiveItem(item, overrides).variants.map((variant) => variant.pricePiastres)).toEqual([3000, 5000]);
    // Prices for other dishes' sizes are not reported for this one.
    expect(itemOverride(item, overrides).prices).toEqual({ large: 5000 });
  });

  it('a branch can mark a dish sold out, or back in stock, on its own', () => {
    const soldOut = toOverrides([{ itemId: 'item-1', isAvailable: false, isHidden: false }], []);
    expect(effectiveItem(item, soldOut).available).toBe(false);
    const backInStock = toOverrides([{ itemId: 'item-1', isAvailable: true, isHidden: false }], []);
    expect(effectiveItem({ ...item, isAvailable: false }, backInStock).available).toBe(true);
    expect(effectiveItem({ ...item, isAvailable: false }, NO_OVERRIDES).available).toBe(false);
  });

  it('hidden anywhere means not visible', () => {
    const hidden = toOverrides([{ itemId: 'item-1', isAvailable: null, isHidden: true }], []);
    expect(effectiveItem(item, hidden).visible).toBe(false);
    expect(effectiveItem({ ...item, isVisible: false }, NO_OVERRIDES).visible).toBe(false);
    // A branch cannot show a dish the shared menu hides.
    const shown = toOverrides([{ itemId: 'item-1', isAvailable: true, isHidden: false }], []);
    expect(effectiveItem({ ...item, isVisible: false }, shown).visible).toBe(false);
  });

  it('recognises overrides that change nothing', () => {
    expect(isEmptyItemOverride({ isAvailable: null, isHidden: false })).toBe(true);
    expect(isEmptyItemOverride({ isAvailable: false, isHidden: false })).toBe(false);
    expect(isEmptyItemOverride({ isAvailable: null, isHidden: true })).toBe(false);
  });
});
