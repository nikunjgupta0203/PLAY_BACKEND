/**
 * scoring — the field engine (plans 7, 8).
 *
 * A heat has many entrants, not two sides: a race, a lifting flight, a long
 * jump, a judged routine, a battle-royale lobby, or a group of golfers,
 * bowlers or archers. Pure functions over a complete state, like the match
 * engine (scoring R3); what an event means comes from the rule, never from a
 * sport (scoring R4). The only switch is on `rule.kind` and the rule's own
 * fields.
 */

/** Plan 7 — measured or judged performances. */
export interface PerformanceRule {
  kind: 'performance';
  measure: 'time' | 'distance' | 'height' | 'weight' | 'reps' | 'points' | 'judged';
  better: 'lower' | 'higher';
  /** Attempts per entrant (per lift, when there are lifts). 1 for a race. */
  attempts: number;
  /** Lifting: the lifts whose best good attempts make the total (squat, bench, deadlift). */
  lifts: string[] | null;
  /** Lifting: referees per attempt. The scorer records the majority as `valid`. */
  refereeLights: number | null;
  /** Judged: the panel size. */
  judges: number | null;
  dropHighLow: boolean;
  /** Battle royale: points for 1st, 2nd…; beyond the list, none. */
  placementPoints: number[] | null;
  perKillPoints: number | null;
}

/** Plan 8 — a card per entrant: golf holes, bowling rolls, archery ends. */
export interface ScorecardRule {
  kind: 'scorecard';
  method: 'strokes' | 'tenpin' | 'ends';
  /** Holes, frames or ends. */
  units: number;
  /** Golf: par for each hole. */
  par: number[] | null;
  /** Archery: arrows in an end. */
  arrowsPerEnd: number | null;
}

export type FieldRule = PerformanceRule | ScorecardRule;

export type EntryStatus = 'active' | 'DNS' | 'DNF' | 'DQ';

export interface Attempt {
  lift: string | null;
  /** Null for a pass. */
  value: number | null;
  valid: boolean;
}

export interface EntryRecord {
  status: EntryStatus;
  marks: number[];
  attempts: Attempt[];
  judgeScores: number[] | null;
  placements: { place: number; kills: number }[];
  /** Golf strokes per hole, bowling rolls, or archery arrows (X = 11). */
  card: number[];
}

export interface FieldState {
  kind: FieldRule['kind'];
  entries: Record<string, EntryRecord>;
  /** The organizer closed the heat: the standings are final. */
  closed: boolean;
}

export type FieldEvent =
  | { type: 'mark'; entry: string; value: number }
  | { type: 'attempt'; entry: string; lift: string | null; value: number | null; valid: boolean }
  | { type: 'status'; entry: string; code: Exclude<EntryStatus, 'active'> }
  | { type: 'judge_scores'; entry: string; scores: number[] }
  | { type: 'placement'; entry: string; place: number; kills: number }
  | { type: 'card'; entry: string; values: number[] }
  | { type: 'close' };

export class FieldInputError extends Error {}

/** Archery's inner ten, recorded as its own value so ties can count it. */
export const ARROW_X = 11;

const blank = (): EntryRecord => ({ status: 'active', marks: [], attempts: [], judgeScores: null, placements: [], card: [] });

export function initialFieldState(rule: FieldRule, entryIds: string[]): FieldState {
  return { kind: rule.kind, entries: Object.fromEntries(entryIds.map((id) => [id, blank()])), closed: false };
}

const finite = (n: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function applyFieldEvent(state: FieldState, event: FieldEvent, rule: FieldRule): FieldState {
  if (state.closed) throw new FieldInputError('the heat is closed');
  if (state.kind !== rule.kind) throw new FieldInputError(`a ${state.kind} heat cannot take a ${rule.kind} event`);
  if (event.type === 'close') return { ...state, closed: true };

  const current = state.entries[event.entry];
  if (!current) throw new FieldInputError('that entrant is not in this heat');
  if (current.status !== 'active' && event.type !== 'status') throw new FieldInputError(`that entrant is ${current.status}`);
  const put = (record: EntryRecord): FieldState => ({ ...state, entries: { ...state.entries, [event.entry]: record } });

  if (event.type === 'status') return put({ ...current, status: event.code });

  if (rule.kind === 'performance') {
    switch (event.type) {
      case 'mark':
        if (!finite(event.value)) throw new FieldInputError('a mark is a number, never negative');
        if (current.marks.length >= rule.attempts) throw new FieldInputError('every attempt has been used');
        return put({ ...current, marks: [...current.marks, event.value] });
      case 'attempt': {
        if (event.value !== null && !finite(event.value)) throw new FieldInputError('an attempt is a number, never negative');
        if (rule.lifts && (!event.lift || !rule.lifts.includes(event.lift))) throw new FieldInputError('that is not a lift here');
        const used = current.attempts.filter((a) => a.lift === (rule.lifts ? event.lift : null)).length;
        if (used >= rule.attempts) throw new FieldInputError('every attempt has been used');
        return put({ ...current, attempts: [...current.attempts, { lift: event.lift, value: event.value, valid: event.valid }] });
      }
      case 'judge_scores':
        if (rule.measure !== 'judged' || event.scores.length !== rule.judges) {
          throw new FieldInputError(`a routine needs ${rule.judges ?? 0} judges’ scores`);
        }
        if (!event.scores.every((x) => finite(x) && x <= 10)) throw new FieldInputError('a judge scores 0 to 10');
        return put({ ...current, judgeScores: event.scores });
      case 'placement':
        if (!rule.placementPoints) throw new FieldInputError('this contest has no placements');
        if (!Number.isInteger(event.place) || event.place < 1 || !Number.isInteger(event.kills) || event.kills < 0) {
          throw new FieldInputError('a placement is a place from 1 and whole kills');
        }
        return put({ ...current, placements: [...current.placements, { place: event.place, kills: event.kills }] });
      default:
        throw new FieldInputError(`a performance heat does not take ${event.type}`);
    }
  }

  if (event.type !== 'card') throw new FieldInputError(`a scorecard heat does not take ${event.type}`);
  if (!event.values.length || !event.values.every((v) => Number.isInteger(v) && v >= 0)) {
    throw new FieldInputError('card values are whole numbers');
  }
  const card = [...current.card, ...event.values];
  switch (rule.method) {
    case 'strokes':
      if (event.values.some((v) => v < 1 || v > 20)) throw new FieldInputError('strokes on a hole are 1 to 20');
      if (card.length > rule.units) throw new FieldInputError('every hole is already scored');
      break;
    case 'tenpin':
      if (!validBowling(card)) throw new FieldInputError('those rolls are not possible in ten-pin');
      break;
    case 'ends':
      if (event.values.length !== rule.arrowsPerEnd) throw new FieldInputError(`an end is ${rule.arrowsPerEnd ?? 0} arrows`);
      if (event.values.some((v) => v > ARROW_X)) throw new FieldInputError('an arrow scores 0 to 10, or X');
      if (card.length > rule.units * (rule.arrowsPerEnd ?? 0)) throw new FieldInputError('every end is already shot');
      break;
  }
  return put({ ...current, card });
}

// --- ten-pin -----------------------------------------------------------------------

/** Rolls that a real game could contain, so far: never more pins than stand, never past the tenth frame. */
function validBowling(rolls: number[]): boolean {
  let i = 0;
  for (let frame = 0; frame < 10; frame += 1) {
    if (i >= rolls.length) return true;
    const first = rolls[i]!;
    if (first > 10) return false;
    if (frame < 9) {
      if (first === 10) {
        i += 1;
        continue;
      }
      const second = rolls[i + 1];
      if (second === undefined) return true;
      if (first + second > 10) return false;
      i += 2;
      continue;
    }
    // Tenth frame: up to three rolls, a fresh rack after a strike or spare.
    const tenth = rolls.slice(i);
    if (tenth.length > 3) return false;
    let standing = 10;
    for (const [k, v] of tenth.entries()) {
      if (v > standing) return false;
      standing = v === standing ? 10 : standing - v;
      if (k === 1 && tenth[0]! < 10 && tenth[0]! + v < 10 && tenth.length > 2) return false; // open tenth: two rolls only
    }
    return true;
  }
  return i >= rolls.length;
}

/** Plan 8 — a ten-pin score: a strike is 10 + the next two rolls, a spare 10 + the next one. */
export function bowlingTotal(rolls: number[]): number {
  let total = 0;
  let i = 0;
  for (let frame = 0; frame < 10 && i < rolls.length; frame += 1) {
    if (rolls[i] === 10) {
      total += 10 + (rolls[i + 1] ?? 0) + (rolls[i + 2] ?? 0);
      i += 1;
    } else if ((rolls[i] ?? 0) + (rolls[i + 1] ?? 0) === 10) {
      total += 10 + (rolls[i + 2] ?? 0);
      i += 2;
    } else {
      total += (rolls[i] ?? 0) + (rolls[i + 1] ?? 0);
      i += 2;
    }
  }
  return total;
}

// --- standings -----------------------------------------------------------------------

export interface Standing {
  entry: string;
  /** 1-based; entrants level on every criterion share it. Null for DNS/DNF/DQ or no result yet. */
  place: number | null;
  /** The number that ranks: time, total, points, strokes. Null with no result. */
  value: number | null;
  /** How the value reads: "−1 thru 2", "220 kg". */
  display: string | null;
  status: EntryStatus;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The ranking value and its tie-breaks, from the rule. Null: no result yet. */
function scoreOf(
  rec: EntryRecord,
  rule: FieldRule,
): { value: number | null; ties: number[]; display: string | null; rank?: number } {
  if (rule.kind === 'scorecard') {
    if (!rec.card.length) return { value: null, ties: [], display: null };
    if (rule.method === 'strokes') {
      const strokes = rec.card.reduce((s, v) => s + v, 0);
      const par = (rule.par ?? []).slice(0, rec.card.length).reduce((s, v) => s + v, 0);
      const diff = strokes - par;
      const toPar = diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `−${-diff}`;
      // Golfers on different holes rank by score against par, not raw strokes.
      return { value: strokes, rank: diff, ties: [], display: `${toPar} thru ${rec.card.length}` };
    }
    if (rule.method === 'tenpin') {
      const total = bowlingTotal(rec.card);
      return { value: total, ties: [], display: String(total) };
    }
    const total = rec.card.reduce((s, v) => s + (v === ARROW_X ? 10 : v), 0);
    const tens = rec.card.filter((v) => v >= 10).length;
    const xs = rec.card.filter((v) => v === ARROW_X).length;
    return { value: total, ties: [tens, xs], display: String(total) };
  }

  if (rule.placementPoints) {
    if (!rec.placements.length) return { value: null, ties: [], display: null };
    const total = rec.placements.reduce(
      (s, p) => s + (rule.placementPoints![p.place - 1] ?? 0) + p.kills * (rule.perKillPoints ?? 0),
      0,
    );
    return { value: total, ties: [], display: String(total) };
  }
  if (rule.measure === 'judged') {
    if (!rec.judgeScores) return { value: null, ties: [], display: null };
    const sorted = [...rec.judgeScores].sort((a, b) => a - b);
    const counted = rule.dropHighLow && sorted.length > 2 ? sorted.slice(1, -1) : sorted;
    const avg = round2(counted.reduce((s, v) => s + v, 0) / counted.length);
    return { value: avg, ties: [], display: avg.toFixed(2) };
  }
  if (rule.lifts) {
    const bests = rule.lifts.map((lift) =>
      Math.max(-1, ...rec.attempts.filter((a) => a.lift === lift && a.valid && a.value !== null).map((a) => a.value!)),
    );
    if (bests.some((b) => b < 0)) return { value: null, ties: [], display: null };
    const total = bests.reduce((s, v) => s + v, 0);
    return { value: total, ties: [], display: String(total) };
  }
  const good = [...rec.marks, ...rec.attempts.filter((a) => a.valid && a.value !== null).map((a) => a.value!)];
  if (!good.length) return { value: null, ties: [], display: null };
  const ordered = [...good].sort((a, b) => (rule.better === 'lower' ? a - b : b - a));
  return { value: ordered[0]!, ties: ordered.slice(1), display: String(ordered[0]) };
}

/** Plans 7, 8 — the heat's standings, best first, ties sharing a place. */
export function standings(state: FieldState, rule: FieldRule): Standing[] {
  const lowerIsBetter = rule.kind === 'scorecard' ? rule.method === 'strokes' : rule.better === 'lower';
  const rows = Object.entries(state.entries).map(([entry, rec]) => {
    const s = scoreOf(rec, rule);
    return { entry, rec, ...s, key: s.rank ?? s.value };
  });
  const ranked = rows.filter((r) => r.rec.status === 'active' && r.value !== null);
  const rest = rows.filter((r) => !(r.rec.status === 'active' && r.value !== null));
  const cmp = (x: (typeof rows)[number], y: (typeof rows)[number]): number => {
    const d = lowerIsBetter ? x.key! - y.key! : y.key! - x.key!;
    if (d !== 0) return d;
    for (let k = 0; k < Math.max(x.ties.length, y.ties.length); k += 1) {
      const t = lowerIsBetter ? (x.ties[k] ?? Infinity) - (y.ties[k] ?? Infinity) : (y.ties[k] ?? -1) - (x.ties[k] ?? -1);
      if (t !== 0) return t;
    }
    return 0;
  };
  ranked.sort(cmp);
  const out: Standing[] = [];
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    const place = prev && cmp(prev, r) === 0 ? out[i - 1]!.place : i + 1;
    out.push({ entry: r.entry, place, value: r.value, display: r.display, status: r.rec.status });
  });
  for (const r of rest) out.push({ entry: r.entry, place: null, value: null, display: null, status: r.rec.status });
  return out;
}

/**
 * Entries split into `count` heats serpentine (1 2 3 3 2 1 1 …), so the
 * registration order — or a seeding — is spread fairly. Never an empty heat.
 */
export function splitIntoHeats(entries: string[], count: number): string[][] {
  const n = Math.max(1, Math.min(count, entries.length));
  const heats: string[][] = Array.from({ length: n }, () => []);
  entries.forEach((entry, i) => {
    const lap = Math.floor(i / n);
    const at = i % n;
    heats[lap % 2 === 0 ? at : n - 1 - at]!.push(entry);
  });
  return heats;
}

/**
 * Who goes through to the next round: the top `perHeat` places of every heat
 * (Q), then the `best` next performances across all heats (q). Entrants with
 * no result, DNS, DNF or DQ never qualify. Best performance first — the
 * running order of the next round. Ties at the cut all go through.
 */
export function qualifiers(heats: FieldState[], rule: FieldRule, opts: { perHeat: number; best: number }): string[] {
  const merged = (only?: Set<string>): FieldState => ({
    kind: rule.kind,
    closed: false,
    entries: Object.fromEntries(
      heats.flatMap((h) => Object.entries(h.entries)).filter(([entry]) => !only || only.has(entry)),
    ),
  } as FieldState);
  const auto = new Set(
    heats.flatMap((h) => standings(h, rule).filter((s) => s.place !== null && s.place <= opts.perHeat).map((s) => s.entry)),
  );
  const rest = standings(merged(), rule).filter((s) => s.place !== null && !auto.has(s.entry));
  const cutoff = rest[Math.min(opts.best, rest.length) - 1];
  const extra = opts.best > 0 && cutoff ? rest.filter((s) => s.place! <= cutoff.place!) : [];
  const through = new Set([...auto, ...extra.map((s) => s.entry)]);
  return standings(merged(through), rule).map((s) => s.entry);
}
