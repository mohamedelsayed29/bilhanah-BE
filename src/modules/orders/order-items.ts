import type { KitchenReadyRule, OrderItemStatus, OrderStatus } from '@bilhanah/contracts';

/** The order's forward path while the kitchen works on it. */
const PATH: OrderStatus[] = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'];

/**
 * Where an order's dishes put it: the furthest step they justify, never back. Cancelled dishes do
 * not count; with only cancelled dishes the order is left for the staff to close. Under the MANUAL
 * rule the dishes take an order no further than preparing (someone marks it ready), though serving
 * every dish of a ready order completes it.
 */
export function orderTargetFromItems(items: readonly OrderItemStatus[], rule: KitchenReadyRule, current: OrderStatus): OrderStatus | null {
  const active = items.filter((status) => status !== 'CANCELLED');
  if (!active.length) return null;
  const all = (...statuses: OrderItemStatus[]) => active.every((status) => statuses.includes(status));
  const any = (...statuses: OrderItemStatus[]) => active.some((status) => statuses.includes(status));
  let target: OrderStatus | null = null;
  if (all('SERVED')) target = rule === 'ALL_ITEMS' || current === 'READY' ? 'COMPLETED' : 'PREPARING';
  else if (all('READY', 'SERVED')) target = rule === 'ALL_ITEMS' ? 'READY' : 'PREPARING';
  else if (any('PREPARING', 'READY', 'SERVED')) target = 'PREPARING';
  else if (any('ACCEPTED')) target = 'ACCEPTED';
  return target;
}

/** The statuses an order passes through from `current` to `target` (empty when it is already there or past it). */
export function forwardSteps(current: OrderStatus, target: OrderStatus | null): OrderStatus[] {
  const from = PATH.indexOf(current);
  const to = target ? PATH.indexOf(target) : -1;
  if (from < 0 || to <= from) return [];
  return PATH.slice(from + 1, to + 1);
}

/** What an order's own status change does to its dishes: which steps move, and to where. */
export function itemCascade(status: OrderStatus): { from: OrderItemStatus[]; to: OrderItemStatus } | null {
  switch (status) {
    case 'ACCEPTED': return { from: ['NEW'], to: 'ACCEPTED' };
    case 'PREPARING': return { from: ['NEW', 'ACCEPTED'], to: 'PREPARING' };
    case 'READY': return { from: ['NEW', 'ACCEPTED', 'PREPARING'], to: 'READY' };
    case 'COMPLETED': return { from: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'], to: 'SERVED' };
    case 'REJECTED':
    case 'CANCELLED': return { from: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'], to: 'CANCELLED' };
    default: return null;
  }
}

/** The timestamps a dish gets on reaching a step (a recall back to preparing clears its ready time). */
export function itemTimestamps(status: OrderItemStatus, now: Date, previous: OrderItemStatus | null = null) {
  switch (status) {
    case 'ACCEPTED': return { acceptedAt: now };
    case 'PREPARING': return previous === 'READY' ? { readyAt: null } : { startedAt: now };
    case 'READY': return { readyAt: now };
    case 'SERVED': return { servedAt: now };
    case 'CANCELLED': return { cancelledAt: now };
    default: return {};
  }
}
