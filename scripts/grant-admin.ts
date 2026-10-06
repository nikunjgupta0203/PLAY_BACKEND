/**
 * Bootstraps PL4Y staff from the command line (25-admin-portal: the first
 * admin). Every later change is made in the portal, by an admin, with a
 * reason (portal R3). This is the only grant with no `granted_by`.
 *
 *   pnpm admin:grant someone@example.com admin     # admin | support | finance
 *   pnpm admin:grant someone@example.com none      # take the role away
 *
 * The person must already have a PL4Y account (sign in to the app once).
 */
import { db } from '../src/platform/db.js';
import { identity } from '../src/modules/identity/index.js';
import { recordAudit } from '../src/platform/audit.js';

const [email, roleArg] = process.argv.slice(2);
const ROLES = ['admin', 'support', 'finance', 'none'] as const;

async function main(): Promise<void> {
  if (!email || !roleArg || !ROLES.includes(roleArg as (typeof ROLES)[number])) {
    console.error('Usage: pnpm admin:grant <email> <admin|support|finance|none>');
    process.exit(2);
  }
  const user = await identity.findByEmail(email);
  if (!user) {
    console.error(`No PL4Y account for ${email}. Sign in to the app with it once, then run this again.`);
    process.exit(1);
  }
  const role = roleArg === 'none' ? null : (roleArg as 'admin' | 'support' | 'finance');
  await db.$transaction(async (tx) => {
    await identity.setPlatformRole(tx, null, user.id, role);
    await recordAudit(tx, {
      actorUserId: user.id,
      action: 'platform_staff.set_role',
      targetType: 'platform_staff',
      targetId: user.id,
      reason: 'Granted from the command line (bootstrap).',
      details: { role, via: 'scripts/grant-admin.ts' },
    });
  });
  console.log(role ? `${user.displayName} <${email}> is now ${role}.` : `${user.displayName} <${email}> is no longer staff.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
