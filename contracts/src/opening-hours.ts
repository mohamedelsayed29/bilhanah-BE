import { z } from 'zod';

/** Week order used in Egypt. */
export const WEEKDAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

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

const JS_WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function localTime(at: Date, timeZone: string): { day: Weekday; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = part('weekday').toLowerCase().slice(0, 3) as Weekday;
  return { day, minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

/** Whether the restaurant is open at `at`, in its own time zone. */
export function isOpenAt(hours: OpeningHours, at: Date, timeZone: string): boolean {
  const { day, minute } = localTime(at, timeZone);
  const previous = JS_WEEKDAYS[(JS_WEEKDAYS.indexOf(day) + 6) % 7]!;
  const today = hours[day].some(({ opens, closes }) => {
    const [start, end] = [minutes(opens), minutes(closes)];
    return start < end ? minute >= start && minute < end : minute >= start;
  });
  // Ranges from the previous day that run past midnight.
  const carriedOver = hours[previous].some(({ opens, closes }) => {
    const [start, end] = [minutes(opens), minutes(closes)];
    return start > end && minute < end;
  });
  return today || carriedOver;
}
