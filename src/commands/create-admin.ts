import { emailSchema } from '@bilhanah/contracts';
import type { PrismaClient } from '@bilhanah/database';
import { z } from 'zod';

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
): Promise<{ id: string; email: string }> {
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

  return prisma.user.create({
    data: {
      email: input.email,
      fullName: input.fullName,
      passwordHash: await hashPassword(input.password),
      role: 'ADMIN',
      // Provisioned by an operator with server access.
      emailVerifiedAt: new Date(),
    },
    select: { id: true, email: true },
  });
}
