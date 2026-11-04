import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
const http = () => request(t.app.getHttpServer());
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const TZ = 'Africa/Cairo';

/** The restaurant's local date and a wall-clock time `minutes` from now ("2026-11-04", "09:35"). */
function local(minutes = 0) {
  const at = new Date(Date.now() + minutes * 60_000);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return { day, time };
}

const POLICY = {
  methods: ['PORTAL', 'KIOSK'], primaryMethod: 'PORTAL', graceMinutes: 10, earlyCheckInMinutes: 30, lateCheckOutMinutes: 60, recordOvertime: true,
  allowWithoutShift: false, allowOutsideShift: false, allowMultipleShifts: false, requireCheckOut: true, correctionsEnabled: true, manualNeedsApproval: false,
  qrMode: 'DYNAMIC', qrTtlSeconds: 30, locationMode: 'OFF', latitude: null, longitude: null, radiusMeters: null,
};

async function restaurant(email = 'owner@koshary.test', subdomain = 'koshary') {
  const token = await signUpOwner(t, email);
  await http().post('/v1/restaurants').set(auth(token))
    .send({ name: 'Koshary Abou Tarek', contactName: 'Tarek', phone: '01012345678', city: 'Cairo', address: '16 Maarouf St', subdomain }).expect(201);
  const branchId = (await http().get('/v1/branches').set(auth(token)).expect(200)).body.branches[0].id as string;
  await http().put('/v1/attendance/policies/restaurant').set(auth(token)).send(POLICY).expect(200);
  return { token, branchId };
}

async function staff(owner: string, role: string, email: string) {
  const created = await http().post('/v1/kitchen-accounts').set(auth(owner)).send({ fullName: `${role} one`, email, password: 'staff-password', role }).expect(201);
  const token = (await http().post('/v1/auth/login').set('Origin', DASHBOARD_ORIGIN).send({ email, password: 'staff-password' }).expect(200)).body.accessToken as string;
  return { id: created.body.id as string, token };
}

/** An employee (optionally linked to a staff account) with a shift that started `startedMinutesAgo`. */
async function employeeWithShift(owner: string, branchId: string, userId: string | null, startedMinutesAgo = 20) {
  const employee = (await http().post('/v1/attendance/employees').set(auth(owner)).send({ fullName: 'Sami', branchId, userId }).expect(201)).body;
  const start = local(-startedMinutesAgo);
  await http().post('/v1/attendance/shifts').set(auth(owner))
    .send({ employeeIds: [employee.id], days: [start.day], start: start.time, end: local(240).time }).expect(201);
  return employee as { id: string; employeeNumber: string };
}

const punch = (token: string, action: 'CHECK_IN' | 'CHECK_OUT', key = randomUUID()) => http().post('/v1/attendance/me/punch').set(auth(token)).send({ action, idempotencyKey: key });

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

describe('attendance: employee portal', () => {
  it('checks in against the shift (late after the grace period), refuses duplicates, repeats nothing, and checks out', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    await employeeWithShift(r.token, r.branchId, waiter.id, 20);

    const me = (await http().get('/v1/attendance/me').set(auth(waiter.token)).expect(200)).body;
    expect(me).toMatchObject({ methods: ['PORTAL', 'KIOSK'], open: null });
    expect(me.todayShifts).toHaveLength(1);

    const key = randomUUID();
    const first = (await punch(waiter.token, 'CHECK_IN', key).expect(200)).body;
    expect(first).toMatchObject({ action: 'CHECK_IN', record: { status: 'LATE', checkInMethod: 'PORTAL' } });
    expect(first.record.lateMinutes).toBeGreaterThanOrEqual(19);
    // The same request again (a retry) records nothing new; a second check-in is refused.
    expect((await punch(waiter.token, 'CHECK_IN', key).expect(200)).body.record.id).toBe(first.record.id);
    expect((await punch(waiter.token, 'CHECK_IN').expect(409)).body.error.code).toBe('ALREADY_CHECKED_IN');

    const out = (await punch(waiter.token, 'CHECK_OUT').expect(200)).body;
    expect(out.record).toMatchObject({ id: first.record.id, checkOutMethod: 'PORTAL', status: 'LATE' });
    expect(out.record.earlyLeaveMinutes).toBeGreaterThan(200);
    // One session per shift.
    expect((await punch(waiter.token, 'CHECK_IN').expect(409)).body.error.code).toBe('SHIFT_DONE');
    expect((await punch(waiter.token, 'CHECK_OUT').expect(409)).body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('needs a shift (unless allowed), an enabled method, and an employee record', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    expect((await http().get('/v1/attendance/me').set(auth(waiter.token)).expect(403)).body.error.code).toBe('NOT_AN_EMPLOYEE');
    await http().post('/v1/attendance/employees').set(auth(r.token)).send({ fullName: 'Sami', branchId: r.branchId, userId: waiter.id }).expect(201);
    expect((await punch(waiter.token, 'CHECK_IN').expect(409)).body.error.code).toBe('NO_SHIFT');
    await http().put('/v1/attendance/policies/restaurant').set(auth(r.token)).send({ ...POLICY, allowWithoutShift: true }).expect(200);
    expect((await punch(waiter.token, 'CHECK_IN').expect(200)).body.record).toMatchObject({ shift: null, status: 'PRESENT' });

    // The branch turns the portal off: only the kiosk.
    await http().put(`/v1/attendance/policies/branches/${r.branchId}`).set(auth(r.token)).send({ ...POLICY, methods: ['KIOSK'], primaryMethod: 'KIOSK', allowWithoutShift: true }).expect(200);
    expect((await punch(waiter.token, 'CHECK_OUT').expect(403)).body.error.code).toBe('METHOD_NOT_ALLOWED');
    // Fingerprint cannot be turned on before a device exists.
    expect((await http().put('/v1/attendance/policies/restaurant').set(auth(r.token)).send({ ...POLICY, methods: ['FINGERPRINT'], primaryMethod: 'FINGERPRINT' }).expect(400)).body.error.code).toBe('POLICY_INVALID');
  });

  it('rejects or flags check-ins away from the branch', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    await http().post('/v1/attendance/employees').set(auth(r.token)).send({ fullName: 'Sami', branchId: r.branchId, userId: waiter.id }).expect(201);
    const place = { latitude: 30.0444, longitude: 31.2357, radiusMeters: 100 };
    await http().put('/v1/attendance/policies/restaurant').set(auth(r.token)).send({ ...POLICY, allowWithoutShift: true, allowMultipleShifts: true, locationMode: 'REJECT', ...place }).expect(200);
    const far = { latitude: 30.06, longitude: 31.2357 };
    const refused = await http().post('/v1/attendance/me/punch').set(auth(waiter.token)).send({ action: 'CHECK_IN', idempotencyKey: randomUUID(), location: far }).expect(403);
    expect(refused.body.error.code).toBe('OUTSIDE_LOCATION');
    await http().post('/v1/attendance/me/punch').set(auth(waiter.token)).send({ action: 'CHECK_IN', idempotencyKey: randomUUID(), location: { latitude: 30.0445, longitude: 31.2357 } }).expect(200);
    await punch(waiter.token, 'CHECK_OUT').expect(403);

    await http().put('/v1/attendance/policies/restaurant').set(auth(r.token)).send({ ...POLICY, allowWithoutShift: true, allowMultipleShifts: true, locationMode: 'FLAG', ...place }).expect(200);
    const flagged = (await http().post('/v1/attendance/me/punch').set(auth(waiter.token)).send({ action: 'CHECK_OUT', idempotencyKey: randomUUID(), location: far }).expect(200)).body;
    expect(flagged).toMatchObject({ flagged: true, record: { flagged: true } });
  });
});

describe('attendance: QR code', () => {
  it('accepts the branch\'s live code and refuses forged or foreign ones', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    await employeeWithShift(r.token, r.branchId, waiter.id, 5);
    await http().put('/v1/attendance/policies/restaurant').set(auth(r.token)).send({ ...POLICY, methods: ['QR'], primaryMethod: 'QR' }).expect(200);
    const live = (await http().get(`/v1/attendance/qr/${r.branchId}`).set(auth(r.token)).expect(200)).body as { url: string };
    const code = new URL(live.url).searchParams.get('c')!;
    expect(code).toMatch(/^d_/);

    const scan = (value: string) => http().post('/v1/attendance/me/qr').set(auth(waiter.token)).send({ code: value, idempotencyKey: randomUUID() });
    expect((await scan(`${code.slice(0, -2)}xx`).expect(400)).body.error.code).toBe('QR_INVALID');
    expect((await scan(live.url).expect(200)).body).toMatchObject({ action: 'CHECK_IN', record: { checkInMethod: 'QR', status: 'PRESENT' } });
    // The same code again toggles to check-out.
    expect((await scan(code).expect(200)).body.action).toBe('CHECK_OUT');

    // Another restaurant's code means nothing here.
    const other = await restaurant('owner@felfela.test', 'felfela');
    await http().put('/v1/attendance/policies/restaurant').set(auth(other.token)).send({ ...POLICY, methods: ['QR'], primaryMethod: 'QR' }).expect(200);
    const foreign = new URL((await http().get(`/v1/attendance/qr/${other.branchId}`).set(auth(other.token)).expect(200)).body.url).searchParams.get('c')!;
    expect((await scan(foreign).expect(400)).body.error.code).toBe('QR_INVALID');
  });
});

describe('attendance: PIN kiosk', () => {
  it('activates once with a code, checks employees in and out by number and PIN, and locks after wrong PINs', async () => {
    const r = await restaurant();
    const employee = await employeeWithShift(r.token, r.branchId, null, 0);
    const pin = (await http().post(`/v1/attendance/employees/${employee.id}/pin`).set(auth(r.token)).expect(200)).body.pin as string;
    expect(pin).toMatch(/^\d{6}$/);
    const listed = (await http().get('/v1/attendance/employees').set(auth(r.token)).expect(200)).body;
    expect(JSON.stringify(listed)).not.toContain(pin);

    const { activation } = (await http().post('/v1/attendance/kiosks').set(auth(r.token)).send({ name: 'Front door', branchId: r.branchId }).expect(201)).body;
    await http().get('/v1/attendance-kiosk/state').expect(401);
    const { token } = (await http().post('/v1/attendance-kiosk/activate').send({ code: activation.code }).expect(200)).body;
    // The code works once.
    await http().post('/v1/attendance-kiosk/activate').send({ code: activation.code }).expect(400);
    const kiosk = (headers: Record<string, string> = {}) => ({ 'X-Kiosk-Token': token, ...headers });
    expect((await http().get('/v1/attendance-kiosk/state').set(kiosk()).expect(200)).body.kiosk).toMatchObject({ name: 'Front door', restaurantName: 'Koshary Abou Tarek' });

    const tap = (number: string, value: string) => http().post('/v1/attendance-kiosk/punch').set(kiosk()).send({ employeeNumber: number, pin: value, idempotencyKey: randomUUID() });
    const checkedIn = (await tap(employee.employeeNumber, pin).expect(200)).body;
    expect(checkedIn).toMatchObject({ action: 'CHECK_IN', mustChangePin: true, record: { checkInMethod: 'KIOSK', kioskName: 'Front door' } });
    await http().post('/v1/attendance-kiosk/pin').set(kiosk()).send({ employeeNumber: employee.employeeNumber, pin, newPin: '2468' }).expect(204);
    expect((await tap(employee.employeeNumber, '2468').expect(200)).body).toMatchObject({ action: 'CHECK_OUT', mustChangePin: false });

    for (let attempt = 0; attempt < 5; attempt++) expect((await tap(employee.employeeNumber, '0000').expect(401)).body.error.code).toBe('PIN_INVALID');
    expect((await tap(employee.employeeNumber, '2468').expect(429)).body.error.code).toBe('KIOSK_LOCKED');

    // Disabled: the screen is signed out.
    const kioskId = (await http().get('/v1/attendance/kiosks').set(auth(r.token)).expect(200)).body[0].id;
    await http().post(`/v1/attendance/kiosks/${kioskId}/disable`).set(auth(r.token)).expect(200);
    await http().get('/v1/attendance-kiosk/state').set(kiosk()).expect(401);
  });
});

describe('attendance: management', () => {
  it('shows the day, takes corrections through approval with an audit trail, and exports', async () => {
    const r = await restaurant();
    const waiter = await staff(r.token, 'WAITER', 'waiter@koshary.test');
    const manager = await staff(r.token, 'MANAGER', 'manager@koshary.test');
    await employeeWithShift(r.token, r.branchId, waiter.id, 20);
    const absent = (await http().post('/v1/attendance/employees').set(auth(r.token)).send({ fullName: 'Hoda', branchId: r.branchId }).expect(201)).body;
    const start = local(-60);
    await http().post('/v1/attendance/shifts').set(auth(r.token)).send({ employeeIds: [absent.id], days: [start.day], start: start.time, end: local(120).time }).expect(201);
    const record = (await punch(waiter.token, 'CHECK_IN').expect(200)).body.record;

    const overview = (await http().get('/v1/attendance/overview').set(auth(manager.token)).expect(200)).body;
    expect(overview.totals).toMatchObject({ scheduled: 2, present: 1, absent: 1, late: 1, working: 1 });

    // The waiter forgot the right time: a correction, which a manager without approval rights cannot approve.
    const fixedIn = new Date(Date.now() - 20 * 60_000).toISOString();
    const correction = (await http().post('/v1/attendance/me/corrections').set(auth(waiter.token))
      .send({ day: start.day, recordId: record.id, requestedCheckIn: fixedIn, requestedCheckOut: null, reason: 'I was at the door on time' }).expect(201)).body;
    expect((await http().get('/v1/attendance/records').query({ from: start.day, to: start.day }).set(auth(r.token)).expect(200)).body.items[0].status).toBe('PENDING_CORRECTION');
    await http().post(`/v1/attendance/corrections/${correction.id}/approve`).set(auth(manager.token)).send({}).expect(403);
    const approved = (await http().post(`/v1/attendance/corrections/${correction.id}/approve`).set(auth(r.token)).send({ note: 'Seen on camera' }).expect(200)).body;
    expect(approved).toMatchObject({ status: 'APPROVED', reviewNote: 'Seen on camera' });
    await http().post(`/v1/attendance/corrections/${correction.id}/reject`).set(auth(r.token)).send({}).expect(409);
    const after = (await http().get('/v1/attendance/records').query({ from: start.day, to: start.day }).set(auth(r.token)).expect(200)).body.items[0];
    expect(after.checkInAt).toBe(fixedIn);

    const audit = (await http().get('/v1/kitchen-accounts/activity').set(auth(r.token)).expect(200)).body;
    expect(audit).toBeDefined();
    const log = await t.prisma.auditLog.findMany({ where: { action: 'attendance.correction_approved' } });
    expect(log).toHaveLength(1);
    expect(log[0]!.metadata).toMatchObject({ employeeName: 'Sami', reason: 'I was at the door on time', source: 'CORRECTION' });

    const csv = await http().get('/v1/attendance/reports/export').query({ from: start.day, to: start.day, format: 'csv', lang: 'en' }).set(auth(r.token)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Employee,Employee ID');
    expect(csv.text).toContain('Sami');
    const xls = await http().get('/v1/attendance/reports/export').query({ from: start.day, to: start.day, format: 'xls', report: 'summary' }).set(auth(r.token)).expect(200);
    expect(xls.text).toContain('<Workbook');
    expect(xls.text).toContain('Hoda');
  });

  it('keeps restaurants apart and staff to their permissions', async () => {
    const a = await restaurant();
    const b = await restaurant('owner@felfela.test', 'felfela');
    const employee = (await http().post('/v1/attendance/employees').set(auth(a.token)).send({ fullName: 'Sami', branchId: a.branchId }).expect(201)).body;
    await http().patch(`/v1/attendance/employees/${employee.id}`).set(auth(b.token)).send({ isActive: false }).expect(404);
    await http().post(`/v1/attendance/employees/${employee.id}/pin`).set(auth(b.token)).expect(404);
    expect((await http().get('/v1/attendance/employees').set(auth(b.token)).expect(200)).body).toEqual([]);
    // Another restaurant's branch is unknown.
    await http().post('/v1/attendance/employees').set(auth(b.token)).send({ fullName: 'Xavier', branchId: a.branchId }).expect(404);

    const cashier = await staff(a.token, 'CASHIER', 'cashier@koshary.test');
    await http().get('/v1/attendance/overview').set(auth(cashier.token)).expect(403);
    const manager = await staff(a.token, 'MANAGER', 'manager@koshary.test');
    await http().get('/v1/attendance/overview').set(auth(manager.token)).expect(200);
    await http().post('/v1/attendance/employees').set(auth(manager.token)).send({ fullName: 'Yasmin', branchId: a.branchId }).expect(403);
    await http().put('/v1/attendance/policies/restaurant').set(auth(manager.token)).send(POLICY).expect(403);
  });
});
