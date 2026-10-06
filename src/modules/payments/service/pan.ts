/**
 * payouts R1, R4 — offline checks on what a host types. No API verifies a PAN
 * for us (neither payments provider offers one to merchants), so these are
 * structural: they catch typos and company PANs for free, before a penny test
 * is paid for. The surname check is a flag for staff, never a refusal.
 */

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;

export const normaliseUpper = (v: string): string => v.replace(/\s+/g, '').toUpperCase();

export function checkPan(pan: string): 'ok' | 'INVALID_PAN' | 'PAN_NOT_INDIVIDUAL' {
  if (!PAN_RE.test(pan)) return 'INVALID_PAN';
  // The 4th character is the holder type; P is an individual. Hosting payouts
  // go to people, and a company PAN changes the tax treatment entirely.
  if (pan[3] !== 'P') return 'PAN_NOT_INDIVIDUAL';
  return 'ok';
}

/**
 * For an individual the 5th character is the first letter of the surname.
 * "Surname" is the last word of the name as typed, which is wrong for
 * initial-first names ("S. Ramesh Kumar" may be filed under Kumar or under S),
 * so any word's initial counts — the check exists to catch someone else's PAN,
 * not to police name order.
 */
export function panMatchesSurname(pan: string, legalName: string): boolean {
  const words = legalName
    .trim()
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase());
  return words.includes(pan[4] ?? '');
}

export const checkIfsc = (ifsc: string): boolean => IFSC_RE.test(ifsc);

export const checkAccountNumber = (n: string): boolean => ACCOUNT_RE.test(n);

export const last4 = (v: string): string => v.slice(-4);
