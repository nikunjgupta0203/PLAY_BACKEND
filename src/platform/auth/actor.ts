/**
 * The Actor is what services take instead of a request. It is what makes the
 * same policy apply when a queued job or a webhook handler calls a service
 * (architecture.md §5).
 */
export interface Actor {
  userId: string;
  sessionId: string;
  /** portal R2 — staff-only fields answer only to a portal session. Absent means the app. */
  client?: 'app' | 'portal';
}

/** A job or webhook acting without a user. Never passes a grant check. */
export const SYSTEM_ACTOR: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  sessionId: 'system',
};

export const isSystem = (a: Actor): boolean => a.sessionId === 'system';
