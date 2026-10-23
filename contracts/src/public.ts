import { z } from 'zod';
import { emailSchema } from './common.js';
import type { PlanCode, PlanFeatures } from './plans.js';

export type PublicPlan = {
  code: PlanCode;
  priceMonthlyPiastres: number;
  features: PlanFeatures;
};

export const CONTACT_TOPICS = ['subscription', 'nfc', 'support', 'partnership', 'other'] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export const contactMessageSchema = z.strictObject({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  phone: z.string().trim().max(30).optional(),
  restaurant: z.string().trim().max(80).optional(),
  topic: z.enum(CONTACT_TOPICS).default('other'),
  message: z.string().trim().min(10).max(2000),
  /** Honeypot: hidden from people, filled in by bots. Non-empty submissions are dropped. */
  website: z.string().max(200).optional(),
});
