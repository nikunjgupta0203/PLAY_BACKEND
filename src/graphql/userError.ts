/**
 * The user-error channel, shared by every module's schema (conventions.md §3).
 *
 * Expected, actionable failures are DATA — a typed field in the mutation
 * payload — not GraphQL errors. The client switches on `code`; it never parses
 * `message`.
 */
import { builder } from './builder.js';
import { isUserError, unauthenticated } from '../platform/errors/index.js';
import type { Actor } from '../platform/auth/actor.js';

export interface UserErrorShape {
  code: string;
  message: string;
  retryAfterSeconds?: number | null;
}

export const UserErrorRef = builder.objectRef<UserErrorShape>('UserError').implement({
  description:
    'An expected failure the player can act on. The client switches on `code`, never on `message`.',
  fields: (t) => ({
    code: t.exposeString('code'),
    message: t.exposeString('message'),
    retryAfterSeconds: t.int({
      nullable: true,
      resolve: (e) => e.retryAfterSeconds ?? null,
    }),
  }),
});

/** Runs a service call, turning a UserError into payload data. */
export async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ data: T | null; userError: UserErrorShape | null }> {
  try {
    return { data: await fn(), userError: null };
  } catch (e) {
    if (isUserError(e)) {
      return {
        data: null,
        userError: {
          code: e.code,
          message: e.message,
          retryAfterSeconds: e.retryAfterSeconds ?? null,
        },
      };
    }
    throw e;
  }
}

export function requireActor(ctx: { actor: Actor | null }): Actor {
  if (!ctx.actor) throw unauthenticated();
  return ctx.actor;
}
