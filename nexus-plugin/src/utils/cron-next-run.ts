/**
 * Shared timezone-aware cron next-run calculator.
 *
 * Uses Intl.DateTimeFormat to convert dates to the target timezone before
 * matching — the same mechanism node-cron uses internally (see
 * node-cron/src/time-matcher.js). This ensures our computed nextRunAt values
 * agree with when node-cron actually fires.
 */

function parseDateInTimezone(date: Date, timezone: string): Date {
  const dtf = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  });
  return new Date(dtf.format(date));
}

function matchCronField(value: number, field: string, min: number, max: number): boolean {
  if (field === '*') return true;

  const segments = field.split(',');
  for (const segment of segments) {
    if (segment.includes('/')) {
      const [rangeStr, stepStr] = segment.split('/');
      const step = parseInt(stepStr, 10);
      const start = rangeStr === '*' ? min : parseInt(rangeStr, 10);
      if ((value - start) >= 0 && (value - start) % step === 0) return true;
    } else if (segment.includes('-')) {
      const [startStr, endStr] = segment.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (value >= start && value <= end) return true;
    } else {
      if (parseInt(segment, 10) === value) return true;
    }
  }

  return false;
}

function matchesCron(date: Date, parts: string[]): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    matchCronField(minute, parts[0], 0, 59) &&
    matchCronField(hour, parts[1], 0, 23) &&
    matchCronField(dayOfMonth, parts[2], 1, 31) &&
    matchCronField(month, parts[3], 1, 12) &&
    matchCronField(dayOfWeek, parts[4], 0, 6)
  );
}

/**
 * Calculate the next N execution times for a cron expression, respecting timezone.
 *
 * @param cronExpression - Standard 5-field cron expression
 * @param timezone - IANA timezone string (e.g. 'America/New_York')
 * @param count - Number of next executions to find (default 1)
 * @returns Array of Date objects (in UTC) representing when the cron will fire
 */
export function getNextCronRuns(cronExpression: string, timezone: string = 'UTC', count: number = 1): Date[] {
  const parts = cronExpression.split(/\s+/);
  if (parts.length !== 5) return [];

  const results: Date[] = [];
  const now = new Date();
  let current = new Date(now.getTime());

  // Iterate minute-by-minute, converting to target timezone before matching.
  // Max 525600 iterations = 1 year of minutes.
  const maxIterations = 525600;
  for (let i = 0; i < maxIterations && results.length < count; i++) {
    current = new Date(current.getTime() + 60000);
    const tzDate = parseDateInTimezone(current, timezone);
    if (matchesCron(tzDate, parts)) {
      results.push(new Date(current));
    }
  }

  return results;
}
