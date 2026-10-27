/**
 * Cron expressions, implemented from scratch.
 *
 * Fields: `[second] minute hour day-of-month month day-of-week`. Each field takes `*`, numbers,
 * ranges `a-b`, steps `*\/n` and `a-b/n`, and lists `a,b,c`; months and weekdays also take names
 * (`jan`, `mon`), and weekday 7 is Sunday like 0. As in classic cron, when both day-of-month and
 * day-of-week are restricted a day matches if either matches. Macros: @yearly (@annually),
 * @monthly, @weekly, @daily (@midnight), @hourly.
 */

export interface CronSchedule {
  expression: string;
  seconds: ReadonlySet<number>;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** day-of-month and day-of-week were both restricted: either may match */
  dayOr: boolean;
  /** the expression had a seconds field */
  hasSeconds: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(text: string, label: string, min: number, max: number, names?: string[], nameOffset = 0): Set<number> {
  const values = new Set<number>();
  const toNumber = (token: string): number => {
    const named = names?.indexOf(token.toLowerCase()) ?? -1;
    if (named !== -1) return named + nameOffset;
    if (!/^\d+$/.test(token)) throw new Error(`Invalid ${label} "${token}"`);
    return Number(token);
  };

  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${part}" in ${label}`);

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      from = toNumber(a);
      to = toNumber(b);
    } else {
      from = toNumber(range);
      // `5/15` means "from 5, every 15"
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new Error(`${label} "${part}" is out of range ${String(min)}-${String(max)}`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/**
 * Parse a cron expression; throws with a message naming the bad field
 */
export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error(`Cron expression "${expression}" must have 5 or 6 fields`);
  }
  const hasSeconds = fields.length === 6;
  const [sec, min, hour, dom, month, dow] = hasSeconds ? fields : ['0', ...fields];

  const weekdays = parseField(dow ?? '*', 'day-of-week', 0, 7, DAY_NAMES);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    expression,
    seconds: parseField(sec ?? '0', 'second', 0, 59),
    minutes: parseField(min ?? '*', 'minute', 0, 59),
    hours: parseField(hour ?? '*', 'hour', 0, 23),
    days: parseField(dom ?? '*', 'day-of-month', 1, 31),
    months: parseField(month ?? '*', 'month', 1, 12, MONTH_NAMES, 1),
    weekdays,
    dayOr: dom !== '*' && dow !== '*',
    hasSeconds,
  };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Wall-clock fields of an instant in a time zone (the host's zone when undefined)
 */
function wallClock(date: Date, timeZone: string | undefined): WallClock {
  if (timeZone === undefined) {
    return {
      year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), weekday: date.getDay(),
    };
  }
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const { type, value } of formatter.formatToParts(date)) parts[type] = value;
  return {
    year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']),
    hour: Number(parts['hour']), minute: Number(parts['minute']), second: Number(parts['second']),
    weekday: DAY_NAMES.indexOf((parts['weekday'] ?? '').toLowerCase()),
  };
}

/**
 * Throws a RangeError for a time zone the runtime does not know
 */
export function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat('en-US', { timeZone });
}

function dayMatches(schedule: CronSchedule, clock: WallClock): boolean {
  const dom = schedule.days.has(clock.day);
  const dow = schedule.weekdays.has(clock.weekday);
  return schedule.months.has(clock.month) && (schedule.dayOr ? dom || dow : dom && dow);
}

/**
 * The first matching instant strictly after `after`, evaluated in `timeZone`. Walks forward
 * skipping whole days, hours and minutes that cannot match, so even rare schedules resolve
 * quickly. Returns undefined if nothing matches within ~5 years (e.g. Feb 30).
 */
export function nextRun(schedule: CronSchedule, after: Date, timeZone?: string): Date | undefined {
  const step = schedule.hasSeconds ? 1000 : 60_000;
  let t = Math.floor(after.getTime() / step) * step + step;
  const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;

  while (t <= limit) {
    const clock = wallClock(new Date(t), timeZone);
    const intoMinute = clock.second * 1000;
    if (!dayMatches(schedule, clock)) {
      t += ((23 - clock.hour) * 3600 + (59 - clock.minute) * 60) * 1000 + (60_000 - intoMinute);
    } else if (!schedule.hours.has(clock.hour)) {
      t += (59 - clock.minute) * 60_000 + (60_000 - intoMinute);
    } else if (!schedule.minutes.has(clock.minute)) {
      t += 60_000 - intoMinute;
    } else if (!schedule.seconds.has(clock.second)) {
      t += 1000;
    } else {
      return new Date(t);
    }
    // Land on a whole step again after a jump
    t = Math.ceil(t / step) * step;
  }
  return undefined;
}
