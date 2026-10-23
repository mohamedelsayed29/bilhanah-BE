/**
 * The restaurant's local calendar date at `at`, as a UTC-midnight Date for a
 * Postgres DATE column. Order numbers restart from #1 each local day.
 */
export function businessDay(at: Date, timeZone: string): Date {
  // en-CA formats as YYYY-MM-DD.
  const local = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(`${local}T00:00:00.000Z`);
}
