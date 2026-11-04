import { forwardSteps, itemCascade, orderTargetFromItems } from './order-items.js';

describe('kitchen display: dishes and their order', () => {
  it('moves the order as far as its dishes justify', () => {
    expect(orderTargetFromItems(['NEW', 'NEW'], 'ALL_ITEMS', 'PLACED')).toBeNull();
    expect(orderTargetFromItems(['ACCEPTED', 'NEW'], 'ALL_ITEMS', 'PLACED')).toBe('ACCEPTED');
    expect(orderTargetFromItems(['PREPARING', 'NEW'], 'ALL_ITEMS', 'PLACED')).toBe('PREPARING');
    expect(orderTargetFromItems(['READY', 'PREPARING'], 'ALL_ITEMS', 'PREPARING')).toBe('PREPARING');
    expect(orderTargetFromItems(['READY', 'READY', 'CANCELLED'], 'ALL_ITEMS', 'PREPARING')).toBe('READY');
    expect(orderTargetFromItems(['SERVED', 'SERVED'], 'ALL_ITEMS', 'READY')).toBe('COMPLETED');
    expect(orderTargetFromItems(['CANCELLED'], 'ALL_ITEMS', 'PREPARING')).toBeNull();
  });

  it('leaves ready to people under the manual rule', () => {
    expect(orderTargetFromItems(['READY', 'READY'], 'MANUAL', 'PREPARING')).toBe('PREPARING');
    expect(orderTargetFromItems(['SERVED'], 'MANUAL', 'PREPARING')).toBe('PREPARING');
    expect(orderTargetFromItems(['SERVED'], 'MANUAL', 'READY')).toBe('COMPLETED');
  });

  it('walks forward through every step, never back', () => {
    expect(forwardSteps('PLACED', 'READY')).toEqual(['ACCEPTED', 'PREPARING', 'READY']);
    expect(forwardSteps('READY', 'PREPARING')).toEqual([]);
    expect(forwardSteps('CANCELLED', 'READY')).toEqual([]);
  });

  it('moves the dishes with the order', () => {
    expect(itemCascade('READY')).toEqual({ from: ['NEW', 'ACCEPTED', 'PREPARING'], to: 'READY' });
    expect(itemCascade('REJECTED')?.to).toBe('CANCELLED');
    expect(itemCascade('PLACED')).toBeNull();
  });
});
