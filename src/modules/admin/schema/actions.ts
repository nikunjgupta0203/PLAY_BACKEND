/**
 * What PL4Y staff do to things players made (PLAY_FRONTEND/apps/admin/docs/portal-gaps.md,
 * phase 3): cancel a casual game, take a comment out of its thread.
 *
 * Portal sessions only (portal R2). Every one takes a reason and is audited
 * (portal R3), and tells the people it affects as the owner's own action would.
 * Each change is the owning module's own method; this file decides who may
 * call it.
 */
import { builder } from '../../../graphql/builder.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { games } from '../../games/index.js';
import { AdminGameRef, GAME_SELECT, type GameRow } from './records.js';

const AdminGamePayload = builder
  .objectRef<{ game: GameRow | null; userError: UserErrorShape | null }>('AdminGamePayload')
  .implement({
    fields: (t) => ({
      game: t.field({ type: AdminGameRef, nullable: true, resolve: (p) => p.game }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const isId = (v: string): boolean => /^[0-9a-f-]{36}$/i.test(v);
const gameRow = (id: string) => db.game.findUnique({ where: { id }, select: GAME_SELECT });

builder.mutationFields((t) => ({
  adminCancelGame: t.field({
    type: AdminGamePayload,
    description:
      'games — PL4Y cancels a casual game. Everyone who joined is told, the host too, with the reason, as when the host cancels.',
    args: { gameId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const gameId = String(args.gameId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'game.cancel', targetType: 'game', targetId: gameId }, args.reason, async (reason) => {
          if (!isId(gameId) || !(await gameRow(gameId))) throw new UserError('GAME_NOT_FOUND', 'No such game.');
          await games.cancelByStaff(gameId, reason);
          return gameRow(gameId);
        }),
      );
      return { game: data, userError };
    },
  }),

  adminRemoveGameComment: t.field({
    type: AdminGamePayload,
    description: 'games — takes one comment out of a game’s thread, for everyone. What it said is kept in the audit log.',
    args: { commentId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const commentId = String(args.commentId);
      const { data, userError } = await attempt(async () => {
        const comment = isId(commentId) ? await db.gameComment.findUnique({ where: { id: commentId } }) : null;
        if (!comment) throw new UserError('COMMENT_NOT_FOUND', 'That comment is already gone.');
        // The row is deleted, so the log is the only record of what was removed and whose it was.
        const what = {
          action: 'game.comment_remove',
          targetType: 'game',
          targetId: comment.gameId,
          details: { commentId, authorId: comment.userId, body: comment.body },
        } as const;
        return audited(staff, what, args.reason, async () => {
          await games.removeCommentByStaff(commentId);
          return gameRow(comment.gameId);
        });
      });
      return { game: data, userError };
    },
  }),
}));
