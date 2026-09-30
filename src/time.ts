import { date, utc, zone, InputError } from './contracts/validation.ts';
import type { TimeRange } from './contracts/types.ts';

export function calendarDate(instant: string, timezone: string): string {
  utc(instant, 'instant');
  zone(timezone, 'timezone');
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

export function addCalendarDays(day: string, count: number): string {
  date(day, 'day');
  if (!Number.isSafeInteger(count)) throw new InputError('day offset must be a safe integer');
  const instant = new Date(`${day}T12:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + count);
  return instant.toISOString().slice(0, 10);
}

/** Require an exact local midnight; never silently normalize an absent wall-clock time. */
export function zonedMidnight(day: string, timezone: string): string {
  date(day, 'day');
  zone(timezone, 'timezone');
  const target = Date.parse(`${day}T00:00:00Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const wall = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`);
    if (wall === target) return new Date(guess).toISOString();
    guess += target - wall;
  }
  throw new InputError(`Cannot resolve exact local midnight ${day} in ${timezone}`);
}

export function analysisWeekEnd(instant: string): string {
  const day = calendarDate(instant, 'Europe/Amsterdam');
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addCalendarDays(day, (7 - weekday) % 7);
}

export function analysisWeekRange(weekEnd: string): TimeRange {
  date(weekEnd, 'week_end');
  if (new Date(`${weekEnd}T12:00:00Z`).getUTCDay() !== 0) throw new InputError('Analysis week_end must be Sunday');
  return {
    schema_version: 1,
    from: zonedMidnight(addCalendarDays(weekEnd, -6), 'Europe/Amsterdam'),
    to: zonedMidnight(addCalendarDays(weekEnd, 1), 'Europe/Amsterdam'),
  };
}

export function analysisMonthRange(month: string): TimeRange {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new InputError('month must be YYYY-MM');
  const first = `${month}-01`;
  const next = new Date(`${first}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { schema_version: 1, from: zonedMidnight(first, 'Europe/Amsterdam'), to: zonedMidnight(next.toISOString().slice(0, 10), 'Europe/Amsterdam') };
}
