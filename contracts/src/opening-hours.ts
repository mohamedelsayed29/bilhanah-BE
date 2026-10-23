import { z } from 'zod';


const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM.');

/** A closing time earlier than the opening time runs past midnight. */
const rangeSchema = z
  .strictObject({ opens: timeSchema, closes: timeSchema })
  .refine((range) => range.opens !== range.closes, 'Opening and closing times must differ.');

const daySchema = z.array(rangeSchema).max(3);

/** Each day lists up to three opening ranges; an empty list means closed. */
export const openingHoursSchema = z.strictObject({
  sat: daySchema,
  sun: daySchema,
  mon: daySchema,
  tue: daySchema,
  wed: daySchema,
  thu: daySchema,
  fri: daySchema,
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;
