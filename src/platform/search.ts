/**
 * discovery R1 — free text becomes an ILIKE '%…%' pattern. The player's `%`,
 * `_` and backslash are escaped, so typing "50%" finds "50% off" rather than
 * everything; blank or over-long input is no search at all.
 */
export const SEARCH_MAX_CHARS = 80;

export function containsPattern(raw: string | null | undefined): string | null {
  const term = (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, SEARCH_MAX_CHARS);
  if (term.length === 0) return null;
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
