/**
 * Reads one tab of an .xlsx workbook, or a .csv file, as rows of strings keyed
 * by the header row. No dependency: an .xlsx is a zip of XML, and only the
 * cells' values are needed, never their formatting.
 *
 * Cells are returned as text. A number is its shortest decimal form, so a
 * time typed into a number-formatted cell arrives as a day fraction ("0.75")
 * and the caller decides what it means.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export type SheetRow = { line: number; cells: Record<string, string> };

/** Lowercase, no asterisks, single spaces: "Owner email *" → "owner email". */
export const headerKey = (h: string): string => h.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function readSheet(file: string, tab: string): SheetRow[] {
  const grid = file.toLowerCase().endsWith('.csv') ? parseCsv(readFileSync(file, 'utf8')) : xlsxGrid(readFileSync(file), tab);
  const headerAt = grid.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerAt < 0) return [];
  const headers = grid[headerAt]!.map(headerKey);
  const rows: SheetRow[] = [];
  for (let i = headerAt + 1; i < grid.length; i++) {
    const r = grid[i]!;
    if (!r.some((c) => c.trim() !== '')) continue;
    const cells: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h) cells[h] = (r[j] ?? '').trim();
    });
    rows.push({ line: i + 1, cells });
  }
  return rows;
}

// --- CSV (RFC 4180, as Excel writes it) ---------------------------------------

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// --- XLSX -------------------------------------------------------------------------

function unzip(buf: Buffer): Map<string, Buffer> {
  // End of central directory: the last record, after which only a comment may follow.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory). Save it from Excel as .xlsx, or export the tab as CSV.');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('Damaged .xlsx file.');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s: string): string =>
  s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : null;
};

/** All the text of an element, rich-text runs joined, phonetic hints dropped. */
const textOf = (xml: string): string =>
  decode(
    [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
  );

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxGrid(buf: Buffer, tab: string): string[][] {
  const files = unzip(buf);
  const text = (name: string) => files.get(name)?.toString('utf8') ?? '';
  const workbook = text('xl/workbook.xml');
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], 'name'), rid: attr(m[0], 'r:id') }));
  const sheet = sheets.find((s) => s.name?.toLowerCase() === tab.toLowerCase());
  if (!sheet) throw new Error(`The workbook has no “${tab}” tab (it has: ${sheets.map((s) => s.name).join(', ')}).`);
  const rel = [...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].find((m) => attr(m[0], 'Id') === sheet.rid);
  const target = rel ? attr(rel[0], 'Target')! : '';
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const grid: string[][] = [];
  for (const row of text(path).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(row[0], 'r')) - 1;
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[0].slice(0, c[0].indexOf('>') + 1), 'r');
      const at = ref ? colIndex(ref) : next;
      next = at + 1;
      const type = attr(c[0].slice(0, c[0].indexOf('>') + 1), 't');
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) value = decode(v);
      cells[at] = value;
    }
    grid[r] = Array.from(cells, (x) => x ?? '');
  }
  return Array.from(grid, (x) => x ?? []);
}
