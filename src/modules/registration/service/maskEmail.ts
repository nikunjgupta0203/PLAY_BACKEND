/**
 * I1(d) — the `Invite` returned to a captain who addressed a partner by
 * account id (`playerId` or `playerUserId`) must not hand back that partner's
 * real email address; the captain typed nothing and should not learn it. The
 * real address is still stored on the row as today — this only masks the
 * object handed back from `invitePartner`.
 *
 * Pure and small on purpose: keep the first character of the local part, then
 * '•••', then '@' and the domain unchanged. A one-character local part still
 * keeps that one character (`a` -> `a•••@example.com`).
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}•••@${domain}`;
}
