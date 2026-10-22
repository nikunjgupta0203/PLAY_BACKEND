/**
 * partnerships R2 — one step's answers, checked against form.ts and kept in
 * the shape they are stored in; and the same answers read back with their
 * labels, for the portal, the emails and the CSV.
 *
 * Questions a step does not ask (an unknown key, or a `when` that is not met)
 * are dropped, not refused: the form may be a release ahead of or behind the
 * server, and a stray key is no reason to lose an application.
 */
import { UserError } from '../../../platform/errors/index.js';
import type { Field } from './form.js';

export const AnswerCode = {
  /** A required question was left empty. `details.field` names it. */
  ANSWER_REQUIRED: 'ANSWER_REQUIRED',
  /** An answer is the wrong type, too long, or not one of the options. */
  INVALID_ANSWER: 'INVALID_ANSWER',
} as const;

export const MAX_IMAGES = 10;
export const MAX_ENTRIES = 20;
const MAX_TEXT = 200;
const MAX_LONGTEXT = 3000;
const MAX_URL = 500;
const MAX_NUMBER = 100_000_000;

export type Value = string | number | boolean | string[] | Record<string, unknown>[];
export type Answers = Record<string, Value>;

/** Where a refused answer is, for the form to point at: `venue.locations.2.city`. */
type Path = string[];

const refuse = (code: string, path: Path, message: string): UserError =>
  new UserError(code, message, { details: { field: path.join('.') } });

const empty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Is a `when` met by the answers already read? */
export function asked(field: Field, answers: Record<string, unknown>): boolean {
  if (!field.when) return true;
  const other = answers[field.when.key];
  if (field.when.includes !== undefined) return Array.isArray(other) && other.includes(field.when.includes);
  return other === field.when.equals;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function text(v: unknown, path: Path, label: string, max: number): string {
  if (typeof v !== 'string') throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: enter text.`);
  const s = max === MAX_LONGTEXT ? v.trim() : v.trim().replace(/\s+/g, ' ');
  if (s.length > max) throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: keep it under ${max.toLocaleString('en-IN')} characters.`);
  return s;
}

/** A link as typed, given https:// when the scheme was left off. Only http(s). */
export function url(raw: string): string | null {
  const s = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** "+91 98765 43210" stays readable; it must have 8 to 15 digits and may start with +. */
export function phone(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, ' ');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15 || !/^\+?[\d\s()-]+$/.test(s)) return null;
  return s;
}

/**
 * One answer, checked. `imageRoot` is the folder this attempt's uploads went
 * to: an image outside it is somebody else's (ADR 0003 §C2).
 */
function value(field: Field, v: unknown, path: Path, imageRoot: string): Value {
  const { label } = field;
  switch (field.kind) {
    case 'text':
      return text(v, path, label, MAX_TEXT);
    case 'longtext':
      return text(v, path, label, MAX_LONGTEXT);
    case 'email': {
      const s = text(v, path, label, MAX_TEXT).toLowerCase();
      if (!EMAIL.test(s)) throw refuse(AnswerCode.INVALID_ANSWER, path, 'Enter a valid email address.');
      return s;
    }
    case 'phone': {
      const s = phone(text(v, path, label, 40));
      if (!s) throw refuse(AnswerCode.INVALID_ANSWER, path, 'Enter a phone number with its country code, like +91 98765 43210.');
      return s;
    }
    case 'url': {
      const s = url(text(v, path, label, MAX_URL));
      if (!s) throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: enter a web address, like https://example.com.`);
      return s;
    }
    case 'number': {
      const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_NUMBER) {
        throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: enter a whole number.`);
      }
      return n;
    }
    case 'date':
    case 'datetime': {
      const s = text(v, path, label, 20);
      const ok = (field.kind === 'date' ? DATE : DATETIME).test(s) && !Number.isNaN(Date.parse(field.kind === 'date' ? s : `${s}:00Z`));
      if (!ok) throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: pick a date${field.kind === 'datetime' ? ' and time' : ''}.`);
      return s;
    }
    case 'choice': {
      if (typeof v !== 'string' || !field.options?.some(([o]) => o === v)) {
        throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: pick one of the options.`);
      }
      return v;
    }
    case 'multi': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !field.options?.some(([o]) => o === x))) {
        throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: pick from the options.`);
      }
      // In the order the options are listed, once each.
      return field.options!.map(([o]) => o).filter((o) => (v as string[]).includes(o));
    }
    case 'yesno': {
      if (typeof v !== 'boolean') throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: answer yes or no.`);
      return v;
    }
    case 'image':
    case 'images': {
      const list = field.kind === 'image' ? [v] : v;
      const max = field.kind === 'image' ? 1 : MAX_IMAGES;
      if (!Array.isArray(list) || list.length > max) {
        throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: at most ${max} image${max === 1 ? '' : 's'}.`);
      }
      for (const id of list) {
        if (typeof id !== 'string' || !id.startsWith(`${imageRoot}/`) || id.length > 200 || id.includes('..')) {
          throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: upload the image again.`);
        }
      }
      return field.kind === 'image' ? (list[0] as string) : [...new Set(list as string[])];
    }
    case 'repeat': {
      if (!Array.isArray(v)) throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: add the entries as a list.`);
      if (v.length > MAX_ENTRIES) throw refuse(AnswerCode.INVALID_ANSWER, path, `${label}: at most ${MAX_ENTRIES}.`);
      return v.map((entry, i) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw refuse(AnswerCode.INVALID_ANSWER, [...path, String(i)], `${label}: entry ${i + 1} is empty.`);
        }
        return check(field.fields ?? [], entry as Record<string, unknown>, [...path, String(i)], imageRoot);
      });
    }
  }
}

/** A step's (or a repeat entry's) answers, checked. Throws the first thing wrong. */
export function check(fields: readonly Field[], raw: Record<string, unknown>, path: Path, imageRoot: string): Answers {
  const out: Answers = {};
  for (const field of fields) {
    // `when` reads the cleaned answers, so a condition on a dropped answer is not met.
    if (!asked(field, out)) continue;
    const v = raw[field.key];
    const at = [...path, field.key];
    if (empty(v)) {
      if (field.required || (field.kind === 'repeat' && field.min && field.when)) {
        throw refuse(
          AnswerCode.ANSWER_REQUIRED,
          at,
          field.kind === 'repeat' ? `Add at least one: ${field.label.toLowerCase()}.` : `${field.label} is required.`,
        );
      }
      continue;
    }
    const checked = value(field, v, at, imageRoot);
    if (field.kind === 'repeat' && field.min && (checked as unknown[]).length < field.min) {
      throw refuse(AnswerCode.ANSWER_REQUIRED, at, `Add at least ${field.min}: ${field.label.toLowerCase()}.`);
    }
    if (typeof checked === 'string' && checked === '' && field.required) {
      throw refuse(AnswerCode.ANSWER_REQUIRED, at, `${field.label} is required.`);
    }
    if (checked !== '') out[field.key] = checked;
  }
  return out;
}

/** Every uploaded image in a set of answers, wherever it sits. */
export function images(fields: readonly Field[], answers: Answers): string[] {
  const found: string[] = [];
  for (const field of fields) {
    const v = answers[field.key];
    if (v === undefined) continue;
    if (field.kind === 'image') found.push(v as string);
    else if (field.kind === 'images') found.push(...(v as string[]));
    else if (field.kind === 'repeat') for (const e of v as Answers[]) found.push(...images(field.fields ?? [], e));
  }
  return found;
}

/** An answer as a person reads it. */
export interface Answer {
  key: string;
  label: string;
  /** The answer in words. Null for images and lists of entries. */
  text: string | null;
  /** Image public_ids, for an image question. */
  images: string[];
  /** For a repeat question: each entry's own answers. */
  entries: Answer[][];
}

/** The answers given, labelled and in the form's order. Unanswered questions are left out. */
export function read(fields: readonly Field[], answers: Record<string, unknown>): Answer[] {
  const out: Answer[] = [];
  for (const field of fields) {
    const v = answers[field.key];
    if (empty(v)) continue;
    const base = { key: field.key, label: field.label, text: null as string | null, images: [] as string[], entries: [] as Answer[][] };
    const option = (o: unknown) => field.options?.find(([k]) => k === o)?.[1] ?? String(o);
    switch (field.kind) {
      case 'choice':
        out.push({ ...base, text: option(v) });
        break;
      case 'multi':
        out.push({ ...base, text: (v as unknown[]).map(option).join(', ') });
        break;
      case 'yesno':
        out.push({ ...base, text: v ? 'Yes' : 'No' });
        break;
      case 'number':
        out.push({ ...base, text: Number(v).toLocaleString('en-IN') });
        break;
      case 'datetime':
        out.push({ ...base, text: String(v).replace('T', ' ') });
        break;
      case 'image':
        out.push({ ...base, images: [String(v)] });
        break;
      case 'images':
        out.push({ ...base, images: (v as unknown[]).map(String) });
        break;
      case 'repeat':
        out.push({ ...base, entries: (v as Record<string, unknown>[]).map((e) => read(field.fields ?? [], e)) });
        break;
      default:
        out.push({ ...base, text: String(v) });
    }
  }
  return out;
}

/** One line per answer, entries numbered — the CSV cell and the plain-text email. */
export function flatten(list: Answer[], indent = ''): string[] {
  return list.flatMap((a) => {
    if (a.entries.length > 0) {
      return [`${indent}${a.label}:`, ...a.entries.flatMap((e, i) => [`${indent}  ${i + 1}.`, ...flatten(e, `${indent}    `)])];
    }
    if (a.images.length > 0) return [`${indent}${a.label}: ${a.images.length} image${a.images.length === 1 ? '' : 's'}`];
    return [`${indent}${a.label}: ${a.text ?? ''}`];
  });
}
