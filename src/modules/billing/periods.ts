/**
 * Adds calendar months in UTC, keeping the day of month where possible:
 * Jan 31 + 1 month is the last day of February.
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Where a newly paid or granted period starts: when the restaurant's current
 * coverage (trial or paid, including periods already queued) ends, or now.
 * Paying during a trial therefore keeps the remaining trial days.
 */
export function nextPeriodStart(periods: readonly { endsAt: Date }[], now: Date): Date {
  const latestEnd = periods.reduce((latest, period) => Math.max(latest, period.endsAt.getTime()), 0);
  return new Date(Math.max(now.getTime(), latestEnd));
}
