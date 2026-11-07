/**
 * Restaurant roles and permissions, in one place. A permission is `module.action`; each role has a
 * default set, and some roles may be granted a few more by whoever manages them (e.g. refunds for a
 * cashier). The API checks permissions, never role names, so a new module or a custom role later is
 * a matter of adding entries here.
 */
import type { OrderStatus } from './orders.js';

export const PERMISSIONS = [
  'dashboard.view',
  'menu.view',
  /** Sold out / back in stock at a branch. */
  'menu.availability',
  /** A branch's menu: hidden dishes and its own prices. */
  'menu.branch',
  /** The restaurant's menu: categories, dishes, sizes and prices. */
  'menu.manage',
  'orders.view',
  /** Placing an order for guests (reserved for staff ordering). */
  'orders.create',
  /** Accepting, preparing and marking ready. */
  'orders.update',
  /** Handing over or serving: ready → completed. */
  'orders.complete',
  /** Rejecting or cancelling, with a reason for the diner. */
  'orders.cancel',
  'tables.view',
  /** Adding, editing, removing tables and areas, and laying out the floor. */
  'tables.manage',
  /** Marking a table available, being cleaned or switched off. */
  'tables.status',
  'reservations.view',
  'reservations.manage',
  /** Bills and whether they are paid. */
  'payments.view',
  /** Marking bills paid and settling tables. */
  'payments.process',
  /** Reversing a payment (marking a paid bill unpaid). */
  'payments.refund',
  'service.view',
  'service.manage',
  /** Upselling and cross-selling suggestions. */
  'promotions.manage',
  /** Visits, orders and dishes. */
  'analytics.view',
  /** Revenue, average order value and comparisons. */
  'analytics.financial',
  'staff.view',
  /** Adding, editing, (de)activating and removing staff accounts. */
  'staff.manage',
  /** Choosing a staff member's role and extra permissions. */
  'roles.assign',
  /** A branch's hours, ordering switches and pause. */
  'settings.operational',
  /** The restaurant's profile, branding, ordering and QR codes. */
  'settings.manage',
  'branches.manage',
  /** The subscription and its payments. */
  'billing.manage',
  /** The kitchen screen. */
  'kitchen.view',
  /** Today's attendance, records and reports. */
  'attendance.view',
  /** Employees, shifts, kiosks, PINs and manual attendance. */
  'attendance.manage',
  /** Approving or rejecting attendance corrections. */
  'attendance.approve',
  /** Attendance methods and rules. */
  'attendance.settings',
  /** Opening and closing one's own cash shift, cash in and out of one's drawer. */
  'cash.operate',
  /** Manual adjustments to a drawer (with a reason; may need approval). */
  'cash.adjust',
  /** Every shift, reconciliation history and cash reports. */
  'cash.view',
  /** Reviewing discrepancies and adjustments, correcting closed shifts. */
  'cash.approve',
  /** Registers and the reconciliation rules. */
  'cash.settings',
  /** Stock, movements, ingredients, recipes and suppliers (quantities, not costs). */
  'inventory.view',
  /** Recording waste, entering counted quantities on an open stock count. */
  'inventory.waste',
  /** Receiving and voiding purchases, creating and posting stock counts, transfers out of the branch. */
  'inventory.operate',
  /** Ingredients, units, recipes, suppliers, reorder levels and inventory settings. */
  'inventory.manage',
  /** Unit costs, values, purchase prices, food cost and menu engineering. */
  'inventory.costs',
  /** Approving stock counts whose variance is above the threshold (when the settings ask for it). */
  'inventory.approve',
  /** Diners' reviews and feedback, the stats and the export (contact phones need reviews.respond). */
  'reviews.view',
  /** Replying publicly and following unhappy diners up (with their contact phone). */
  'reviews.respond',
  /** Publishing and hiding reviews. */
  'reviews.moderate',
  /** What diners are asked, what is published, and alerts. */
  'reviews.settings',
  /** Loyalty members, their points and history, and the program's analytics. */
  'loyalty.view',
  /** Adding or removing a member's points (with a reason) and issuing a new member card. */
  'loyalty.adjust',
  /** The program: earning and redemption rules, rewards and tiers. */
  'loyalty.settings',
  /** The POS terminal: taking orders and payments at the counter (docs/POS.md). */
  'pos.use',
  /** Discounts above the cashier limit, and voiding POS orders. */
  'pos.discount',
  /** The POS: activation, settings, devices and integrations. */
  'pos.settings',
  /** The support assistant and the restaurant's tickets with Bilhanah support. */
  'support.use',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The permission each order status change needs (the board shows only the buttons the caller may use). */
export const ORDER_STATUS_PERMISSION: Record<OrderStatus, Permission> = {
  PLACED: 'orders.update',
  ACCEPTED: 'orders.update',
  PREPARING: 'orders.update',
  READY: 'orders.update',
  COMPLETED: 'orders.complete',
  REJECTED: 'orders.cancel',
  CANCELLED: 'orders.cancel',
};

/** The module part of a permission, for grouping them on screen. */
export const permissionModule = (permission: Permission) => permission.split('.')[0]!;

/** OWNER is the restaurant's account; the others are staff accounts it (or a manager) creates. */
export const RESTAURANT_ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const;
export type RestaurantRole = (typeof RESTAURANT_ROLES)[number];

/** Staff roles, in the order they are offered. */
export const STAFF_ROLES = ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

const MANAGER: Permission[] = [
  'dashboard.view', 'menu.view', 'menu.availability', 'menu.branch',
  'orders.view', 'orders.create', 'orders.update', 'orders.complete', 'orders.cancel',
  'tables.view', 'tables.manage', 'tables.status', 'reservations.view', 'reservations.manage',
  'payments.view', 'payments.process', 'service.view', 'service.manage', 'promotions.manage',
  'analytics.view', 'analytics.financial', 'staff.view', 'staff.manage', 'roles.assign', 'settings.operational', 'kitchen.view',
  'attendance.view',
  'cash.operate', 'cash.adjust', 'cash.view', 'cash.approve',
  'inventory.view', 'inventory.waste', 'inventory.operate', 'inventory.costs',
  'reviews.view', 'reviews.respond', 'reviews.moderate',
  'loyalty.view', 'loyalty.adjust',
  'pos.use', 'pos.discount',
  'support.use',
];

/** What each role may do by default. */
export const ROLE_PERMISSIONS: Record<RestaurantRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER,
  CASHIER: ['dashboard.view', 'menu.view', 'orders.view', 'orders.create', 'orders.complete', 'tables.view', 'tables.status', 'payments.view', 'payments.process', 'cash.operate', 'pos.use'],
  WAITER: ['menu.view', 'orders.view', 'orders.create', 'tables.view', 'tables.status', 'reservations.view', 'reservations.manage', 'service.view', 'service.manage'],
  KITCHEN: ['kitchen.view', 'menu.availability', 'orders.view', 'orders.update', 'orders.complete', 'orders.cancel', 'inventory.view', 'inventory.waste'],
};

/** The extra permissions each staff role may be granted, on top of its defaults. */
/** Every inventory permission may be granted to any staff role: the owner decides who does what. */
const INVENTORY_PERMISSIONS: Permission[] = ['inventory.view', 'inventory.waste', 'inventory.operate', 'inventory.manage', 'inventory.costs', 'inventory.approve'];

/** Likewise every reviews permission (a waiter who reads feedback, a cashier who replies...). */
const REVIEW_PERMISSIONS: Permission[] = ['reviews.view', 'reviews.respond', 'reviews.moderate', 'reviews.settings'];

/** And every loyalty permission (a cashier who looks members up, a manager who runs the program...). */
const LOYALTY_PERMISSIONS: Permission[] = ['loyalty.view', 'loyalty.adjust', 'loyalty.settings'];

/** And the POS (a waiter who takes orders at the counter, a cashier who gives discounts...). */
const POS_PERMISSIONS: Permission[] = ['pos.use', 'pos.discount', 'pos.settings'];

const extra = (role: StaffRole) => [...INVENTORY_PERMISSIONS, ...REVIEW_PERMISSIONS, ...LOYALTY_PERMISSIONS, ...POS_PERMISSIONS].filter((permission) => !ROLE_PERMISSIONS[role].includes(permission));

export const GRANTABLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  MANAGER: ['payments.refund', 'attendance.manage', 'attendance.approve', 'cash.settings', ...extra('MANAGER')],
  CASHIER: ['payments.refund', 'cash.adjust', 'cash.view', 'support.use', ...extra('CASHIER')],
  WAITER: ['orders.complete', 'support.use', ...extra('WAITER')],
  KITCHEN: extra('KITCHEN'),
};

/** A role's defaults plus the grants it may have (others are ignored). */
export function effectivePermissions(role: string, grants: readonly string[] = []): Permission[] {
  if (!(RESTAURANT_ROLES as readonly string[]).includes(role)) return [];
  const restaurantRole = role as RestaurantRole;
  const allowed = restaurantRole === 'OWNER' ? [] : GRANTABLE_PERMISSIONS[restaurantRole];
  const set = new Set<Permission>(ROLE_PERMISSIONS[restaurantRole]);
  for (const grant of grants) if ((allowed as readonly string[]).includes(grant)) set.add(grant as Permission);
  return PERMISSIONS.filter((permission) => set.has(permission));
}

/**
 * Which staff roles someone may give (and whose accounts they may manage): never OWNER, and only a
 * role whose permissions they hold themselves, without being their own role (so a manager cannot
 * make or change other managers). Owners may give every staff role.
 */
export function assignableRoles(role: string, permissions: readonly Permission[]): StaffRole[] {
  if (!permissions.includes('roles.assign')) return [];
  if (role === 'OWNER') return [...STAFF_ROLES];
  const held = new Set(permissions);
  return STAFF_ROLES.filter((candidate) => candidate !== role && ROLE_PERMISSIONS[candidate].every((permission) => held.has(permission)));
}

/** Extra permissions someone may grant for `role`: those the role allows and they hold themselves. */
export function grantablePermissions(role: StaffRole, permissions: readonly Permission[]): Permission[] {
  return GRANTABLE_PERMISSIONS[role].filter((permission) => permissions.includes(permission));
}

/** Whether a role (with its grants) may do something. */
export const can = (role: string, permission: Permission, grants: readonly string[] = []) => effectivePermissions(role, grants).includes(permission);

/** Roles whose defaults include the permission (e.g. who can take service requests). */
export const rolesWith = (permission: Permission): RestaurantRole[] =>
  RESTAURANT_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));

/** Names on screen: [Arabic, English]. */
export const ROLE_LABELS: Record<RestaurantRole, [string, string]> = {
  OWNER: ['صاحب المطعم', 'Owner'],
  MANAGER: ['مدير', 'Manager'],
  CASHIER: ['كاشير', 'Cashier'],
  WAITER: ['ويتر', 'Waiter'],
  KITCHEN: ['المطبخ', 'Kitchen'],
};

export const PERMISSION_LABELS: Record<Permission, [string, string]> = {
  'dashboard.view': ['الرئيسية', 'Dashboard'],
  'menu.view': ['يشوف المنيو', 'View the menu'],
  'menu.availability': ['يعلّم الصنف خلص أو رجع', 'Mark dishes sold out'],
  'menu.branch': ['منيو الفرع وأسعاره', 'Branch menu and prices'],
  'menu.manage': ['يعدّل المنيو والأسعار', 'Edit the menu and prices'],
  'orders.view': ['يشوف الطلبات', 'View orders'],
  'orders.create': ['يعمل طلب للزبون', 'Place orders for guests'],
  'orders.update': ['يقبل ويحضّر الطلبات', 'Accept and prepare orders'],
  'orders.complete': ['يسلّم الطلبات', 'Complete orders'],
  'orders.cancel': ['يرفض أو يلغي الطلبات', 'Reject or cancel orders'],
  'tables.view': ['يشوف الطاولات', 'View tables'],
  'tables.manage': ['يدير الطاولات والمناطق', 'Manage tables and areas'],
  'tables.status': ['يغيّر حالة الطاولة (متاحة، تنظيف، متوقفة)', 'Change table status (available, cleaning, off)'],
  'reservations.view': ['يشوف الحجوزات', 'View reservations'],
  'reservations.manage': ['يدير الحجوزات', 'Manage reservations'],
  'payments.view': ['يشوف الحسابات', 'View bills'],
  'payments.process': ['يقفل الحسابات', 'Take payments'],
  'payments.refund': ['يرجّع الحساب مش مدفوع', 'Reverse payments'],
  'service.view': ['يشوف طلبات الخدمة', 'View service requests'],
  'service.manage': ['يتعامل مع طلبات الخدمة', 'Handle service requests'],
  'promotions.manage': ['يدير الترشيحات', 'Manage recommendations'],
  'analytics.view': ['يشوف الإحصائيات', 'View insights'],
  'analytics.financial': ['يشوف الإيرادات', 'View revenue'],
  'staff.view': ['يشوف الموظفين', 'View staff'],
  'staff.manage': ['يدير حسابات الموظفين', 'Manage staff accounts'],
  'roles.assign': ['يحدد الأدوار', 'Assign roles'],
  'settings.operational': ['إعدادات الفرع', 'Branch settings'],
  'settings.manage': ['إعدادات المطعم', 'Restaurant settings'],
  'branches.manage': ['يدير الفروع', 'Manage branches'],
  'billing.manage': ['الاشتراك والدفع', 'Subscription and billing'],
  'kitchen.view': ['شاشة المطبخ', 'Kitchen screen'],
  'attendance.view': ['يشوف الحضور', 'View attendance'],
  'attendance.manage': ['يدير الموظفين والشيفتات والحضور', 'Manage employees, shifts and attendance'],
  'attendance.approve': ['يوافق على تصحيحات الحضور', 'Approve attendance corrections'],
  'attendance.settings': ['إعدادات الحضور', 'Attendance settings'],
  'cash.operate': ['يفتح ويقفل شيفت الكاشير', 'Open and close cash shifts'],
  'cash.adjust': ['يعمل تسويات في الدرج', 'Adjust the cash drawer'],
  'cash.view': ['يشوف شيفتات وتقارير الكاش', 'View cash shifts and reports'],
  'cash.approve': ['يوافق على فروقات وتسويات الكاش', 'Approve cash discrepancies and adjustments'],
  'cash.settings': ['إعدادات الخزن والكاش', 'Cash registers and rules'],
  'inventory.view': ['يشوف المخزون', 'View inventory'],
  'inventory.waste': ['يسجل الهالك ويجرد', 'Record waste and count stock'],
  'inventory.operate': ['يستلم المشتريات ويرحّل الجرد والتحويلات', 'Receive purchases, post counts and transfers'],
  'inventory.manage': ['يدير الخامات والوصفات والموردين', 'Manage ingredients, recipes and suppliers'],
  'inventory.costs': ['يشوف التكاليف وتكلفة الأكل', 'View costs and food cost'],
  'inventory.approve': ['يوافق على فروقات الجرد', 'Approve stock count variances'],
  'reviews.view': ['يشوف التقييمات', 'View reviews'],
  'reviews.respond': ['يرد على التقييمات ويتابع الزباين', 'Reply to reviews and follow diners up'],
  'reviews.moderate': ['ينشر أو يخفي التقييمات', 'Publish and hide reviews'],
  'reviews.settings': ['إعدادات التقييمات', 'Review settings'],
  'loyalty.view': ['يشوف أعضاء الولاء ونقاطهم', 'View loyalty members and points'],
  'loyalty.adjust': ['يعدّل نقاط الأعضاء ويصدر كارت العضوية', 'Adjust points and issue member cards'],
  'loyalty.settings': ['إعدادات برنامج الولاء والمكافآت', 'Loyalty rules and rewards'],
  'pos.use': ['يستخدم الكاشير (POS)', 'Use the POS terminal'],
  'pos.discount': ['خصومات أكبر وإلغاء طلبات الكاشير', 'Larger discounts and voiding POS orders'],
  'pos.settings': ['إعدادات الكاشير والأجهزة والربط', 'POS settings, devices and integrations'],
  'support.use': ['الدعم الفني ومساعد بالهنا', 'Support assistant and tickets'],
};
