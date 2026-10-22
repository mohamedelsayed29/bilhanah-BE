import request from 'supertest';
import { createAdmin, CreateAdminError } from '../src/commands/create-admin.js';
import { PasswordService } from '../src/modules/auth/password.service.js';
import { createTestApp, DASHBOARD_ORIGIN, signUpOwner, type TestApp } from './test-app.js';

let t: TestApp;
let hash: (password: string) => Promise<string>;

beforeAll(async () => {
  t = await createTestApp();
  const passwords = t.app.get(PasswordService);
  hash = (password) => passwords.hash(password);
});

afterAll(async () => {
  await t.app.close();
});

beforeEach(async () => {
  await t.reset();
});

const input = { email: ' Admin@Bilhanah.TEST ', fullName: 'Platform Admin', password: 'a-long-admin-password' };

describe('createAdmin', () => {
  it('creates a verified administrator with a hashed password', async () => {
    const admin = await createAdmin(t.prisma, hash, input);
    expect(admin.email).toBe('admin@bilhanah.test');

    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(user).toMatchObject({ role: 'ADMIN', status: 'ACTIVE', fullName: 'Platform Admin' });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('cannot be used to sign in through the owner login', async () => {
    await createAdmin(t.prisma, hash, input);
    await request(t.app.getHttpServer())
      .post('/v1/auth/login')
      .set('Origin', DASHBOARD_ORIGIN)
      .send({ email: input.email, password: input.password })
      .expect(401);
  });

  it('refuses duplicates and never promotes an owner', async () => {
    await createAdmin(t.prisma, hash, input);
    await expect(createAdmin(t.prisma, hash, input)).rejects.toThrow(/already an administrator/);

    await signUpOwner(t, 'owner@koshary.test');
    await expect(createAdmin(t.prisma, hash, { ...input, email: 'owner@koshary.test' })).rejects.toThrow(
      /belongs to a restaurant owner/,
    );
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { email: 'owner@koshary.test' } });
    expect(owner.role).toBe('OWNER');
  });

  it('requires at least 12 password characters', async () => {
    await expect(createAdmin(t.prisma, hash, { ...input, password: 'short-pass1' })).rejects.toBeInstanceOf(
      CreateAdminError,
    );
    expect(await t.prisma.user.count()).toBe(0);
  });
});
