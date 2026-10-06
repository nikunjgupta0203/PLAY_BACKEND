/**
 * Two error channels, and the client never parses a message string
 * (conventions.md §3).
 *
 *   UserError   — something the player can act on. Returned as a typed field
 *                 in a mutation payload. Data, not an exception.
 *   SystemError — something they cannot. A GraphQL error carrying
 *                 extensions.code.
 */
import { GraphQLError } from 'graphql';

/** Codes shared across modules. Module-specific codes live with their module. */
export const SharedCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  NOT_FOUND: 'NOT_FOUND',
} as const;

/**
 * An expected, actionable failure. Services throw it; resolvers catch it and
 * put it in the payload's `userError` field rather than letting it become a
 * GraphQL error.
 */
export class UserError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { retryAfterSeconds?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    if (opts.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = opts.retryAfterSeconds;
    }
    if (opts.details !== undefined) this.details = opts.details;
  }
}

export const isUserError = (e: unknown): e is UserError => e instanceof UserError;

/** A failure the player cannot act on. Surfaces as a GraphQL error. */
export class SystemError extends GraphQLError {
  constructor(
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message, { extensions: { code, ...extra } });
    this.name = 'SystemError';
  }
}

export const unauthenticated = (msg = 'Not authenticated') =>
  new SystemError(SharedCode.UNAUTHENTICATED, msg);

/** Never leak whether the resource exists (conventions.md §3). */
export const forbidden = (code = SharedCode.FORBIDDEN, msg = 'Forbidden') =>
  new SystemError(code, msg);

export const rateLimited = (retryAfterSeconds: number) =>
  new SystemError(SharedCode.RATE_LIMITED, 'Too many requests', {
    retryAfterSeconds,
  });

export const illegalTransition = (from: string, to: string) =>
  new SystemError(
    SharedCode.ILLEGAL_TRANSITION,
    `Illegal transition ${from} -> ${to}`,
  );
