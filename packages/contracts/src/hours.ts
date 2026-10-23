// Opening-hours logic without zod, so web apps can use it without bundling the schemas.
import type { OpeningHours } from './opening-hours.js';

/** Week order used in Egypt. */
export const WEEKDAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

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
