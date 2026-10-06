/**
 * registration R17 — when a waitlist offer lapses.
 *
 * An offer normally lives for the configured TTL (30 minutes). An offer made
 * during quiet hours (notifications R3: 22:00–07:00 IST) cannot be pushed, so
 * it runs to 08:00 IST instead — giving the player an hour after the push
 * actually lands, rather than expiring while they sleep.
 *
 * IST has no daylight saving, so a fixed +05:30 offset is exact.
 */
const IST_OFFSET_MS = 330 * 60_000;
const QUIET_FROM_HOUR = 22;
const QUIET_TO_HOUR = 7;
const QUIET_OFFER_EXPIRES_HOUR = 8;

export function isQuietHours(at: Date): boolean {
  const hour = new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
}

export function offerExpiresAt(now: Date, ttlMs: number): Date {
  if (!isQuietHours(now)) return new Date(now.getTime() + ttlMs);

  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const expiry = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    // Before midnight the next 08:00 is tomorrow; after midnight it is today.
    ist.getUTCDate() + (ist.getUTCHours() >= QUIET_FROM_HOUR ? 1 : 0),
    QUIET_OFFER_EXPIRES_HOUR,
  );
  return new Date(expiry - IST_OFFSET_MS);
}
