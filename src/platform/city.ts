/**
 * City matching. A city is free text everywhere it is typed (onboarding, the
 * host wizard, a venue) and the phone's reverse geocoder has its own opinion,
 * so one place arrives as "Bangalore", "Bengaluru" and "bengaluru ". Every
 * city filter matches through here, or one account's Home shelves come up
 * empty against another account's events.
 */

/** Names of the same city, old and new. Lower case, single-spaced. */
const SAME_CITY: readonly (readonly string[])[] = [
  ['bengaluru', 'bangalore', 'bengaluru urban', 'bangalore urban'],
  ['gurugram', 'gurgaon'],
  ['delhi', 'new delhi'],
  ['mumbai', 'bombay'],
  ['kolkata', 'calcutta'],
  ['chennai', 'madras'],
  ['kochi', 'cochin'],
  ['mysuru', 'mysore'],
  ['puducherry', 'pondicherry'],
  ['vadodara', 'baroda'],
  ['thiruvananthapuram', 'trivandrum'],
  ['prayagraj', 'allahabad'],
];

const groupOf = new Map<string, readonly string[]>(SAME_CITY.flatMap((g) => g.map((n) => [n, g] as const)));

/** Case, outer and doubled spaces do not make a different city. */
export function cityKey(city: string): string {
  return city.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Every key a stored city may have and still be this city. */
export function cityVariants(city: string): string[] {
  const key = cityKey(city);
  return [...(groupOf.get(key) ?? [key])];
}
