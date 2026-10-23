import { z } from 'zod';
import { emailSchema } from './common.js';
import type { PlanCode, PlanFeatures } from './plans.js';

export type PublicPlan = {
  code: PlanCode;
  priceMonthlyPiastres: number;
  features: PlanFeatures;
};

export const CONTACT_TOPICS = ['general', 'sales', 'nfc', 'support'] as const;

export const contactMessageSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  phone: z.string().trim().max(30).optional(),
  topic: z.enum(CONTACT_TOPICS).default('general'),
  message: z.string().trim().min(10).max(2000),
  /** Honeypot: hidden from people, filled in by bots. Non-empty submissions are dropped. */
  website: z.string().max(200).optional(),
});
