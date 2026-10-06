/**
 * Five-field cron in UTC, for the job schedules in worker.ts.
 *
 * Only what those schedules need: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, and lists
 * of them. A pattern outside that throws at registration — at boot, not in the
 * middle of the week the job was meant to run.
 */
interface Field {
  name: string;
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
];

interface Cron {
  fields: Set<number>[];
  /** Standard cron: when BOTH day fields are restricted, either one matching is enough. */
  domAny: boolean;
  dowAny: boolean;
}

function parseField(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m?.[1]) throw new Error(`cron: bad ${field.name} "${part}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    let lo = field.min;
    let hi = field.max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number) as [number, number | undefined];
      lo = a;
      hi = b ?? (m[2] === undefined ? a : field.max);
    }
    if (step < 1 || lo < field.min || hi > field.max || lo > hi) {
      throw new Error(`cron: ${field.name} "${part}" is out of range`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function compile(pattern: string): Cron {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: "${pattern}" needs five fields`);
  return {
    fields: parts.map((p, i) => parseField(p, FIELDS[i]!)),
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

/** Throws when the pattern is not one this parser understands. */
export function parseCron(pattern: string): void {
  compile(pattern);
}

function matches(c: Cron, t: Date): boolean {
  const [minute, hour, dom, month, dow] = c.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!minute.has(t.getUTCMinutes()) || !hour.has(t.getUTCHours())) return false;
  if (!month.has(t.getUTCMonth() + 1)) return false;
  const domOk = dom.has(t.getUTCDate());
  const dowOk = dow.has(t.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** The first minute strictly after `after` that the pattern matches. */
export function nextRun(pattern: string, after: Date): Date {
  const c = compile(pattern);
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  // A year of minutes: every valid pattern matches inside it.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, t)) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new Error(`cron: "${pattern}" never fires`);
}
