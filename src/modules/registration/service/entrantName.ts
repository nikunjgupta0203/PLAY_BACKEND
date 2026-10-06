/**
 * How an entry reads on a bracket or a standings table: the player's name,
 * a pair as "Asha & Meera", a bigger team as its captain "+ N".
 */
export function entrantName(names: string[]): string {
  const [first, second] = names;
  if (!first) return '';
  if (names.length === 1) return first;
  if (names.length === 2) return `${first} & ${second}`;
  return `${first} + ${names.length - 1}`;
}
