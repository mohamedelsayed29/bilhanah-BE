import { emailSchema } from '@bilhanah/contracts';
import type { PrismaClient } from '@bilhanah/database';
import { z } from 'zod';
import type { SecretBox } from '../common/crypto/secret-box.js';
import { generateTotpSecret } from '../common/crypto/totp.js';

/** Administrators get a longer minimum than owners. */
export const adminPasswordSchema = z.string().min(12).max(128);

export const createAdminInputSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(100),
  password: adminPasswordSchema,
});
export type CreateAdminInput = z.input<typeof createAdminInputSchema>;

export class CreateAdminError extends Error {}

/**
 * Provisions a platform administrator. This is the only way to create one:
 * public registration always creates owners, and an existing owner account
 * is never promoted.
 */
export async function createAdmin(
  prisma: PrismaClient,
  hashPassword: (password: string) => Promise<string>,
  rawInput: CreateAdminInput,
  secrets?: SecretBox,
): Promise<{ id: string; email: string; totpSecret: string | null }> {
  const parsed = createAdminInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new CreateAdminError(z.prettifyError(parsed.error));
  const input = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { role: true } });
  if (existing) {
    throw new CreateAdminError(
      existing.role === 'ADMIN'
        ? `${input.email} is already an administrator.`
        : `${input.email} belongs to a restaurant owner. Use a separate email for the administrator.`,
    );
  }

  // Shown to the operator once, for the administrator's authenticator app; stored encrypted.
  const totpSecret = secrets ? generateTotpSecret() : null;
  const admin = await prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      passwordHash: await hashPassword(input.password),
      role: 'ADMIN',
      // Provisioned by an operator with server access.
      emailVerifiedAt: new Date(),
      totpSecret: totpSecret && secrets ? secrets.seal(totpSecret) : null,
    },
    select: { id: true, email: true },
  });
  return { ...admin, totpSecret };
}

/**
 * Gives an administrator a new authenticator secret (e.g. after a lost
 * phone) and signs them out everywhere. Returns the new secret.
 */
export async function resetAdminMfa(prisma: PrismaClient, secrets: SecretBox, rawEmail: string): Promise<string> {
  const email = emailSchema.parse(rawEmail);
  const admin = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!admin || admin.role !== 'ADMIN') throw new CreateAdminError(`${email} is not an administrator.`);
  const totpSecret = generateTotpSecret();
  await prisma.$transaction([
    prisma.user.update({ where: { id: admin.id }, data: { totpSecret: secrets.seal(totpSecret), totpLastStep: null } }),
    prisma.session.updateMany({
      where: { userId: admin.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'REVOKED_BY_USER' },
    }),
  ]);
  return totpSecret;
}

/** Instructions printed for the operator after creating or resetting an administrator. */
export function authenticatorInstructions(email: string, secret: string, uri: string): string {
  return [
    'Add this account to an authenticator app (Google Authenticator, 1Password, Authy, ...):',
    `  Account: ${email}`,
    `  Key:     ${secret.replace(/(.{4})/g, '$1 ').trim()}`,
    `  Or open: ${uri}`,
    'The key is shown only now. Sign-in requires the password and a 6-digit code.',
  ].join('\n');
}
