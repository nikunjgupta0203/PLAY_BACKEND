/**
 * `pnpm seed` — version-controlled reference data (sport R1).
 *
 * Idempotent by construction, so it runs on every deploy rather than once by
 * hand on a laptop that later leaves the company.
 */
import { config, isProd } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { LAUNCH_SPORTS, seedLaunchSports } from '../src/modules/sport/seed.js';

async function main(): Promise<void> {
  const ids = await seedLaunchSports(db);
  console.log(
    `Seeded ${ids.length} sport(s): ${LAUNCH_SPORTS.map((s) => s.slug).join(', ')}`,
  );
  if (!isProd) await seedAccounts(config.DEV_OTP_BYPASS_EMAILS, 'Dev', 'DEV_OTP_CODE');
  // Every environment — config forbids the dev default code for these.
  await seedAccounts(config.TEST_LOGIN_EMAILS, 'Test', 'TEST_LOGIN_CODE');
}

/**
 * The OTP-bypass accounts, with the profile identity R9 requires. Existing
 * accounts are left alone.
 */
async function seedAccounts(emails: Set<string>, label: string, codeVar: string): Promise<void> {
  if (emails.size === 0) return;
  // Loaded lazily so a deploy's seed pulls in the module graph only when needed.
  const { profile } = await import('../src/modules/profile/index.js');

  for (const email of emails) {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`${label} account exists: ${email}`);
      continue;
    }
    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { id: newId(), email, displayName: email.slice(0, email.indexOf('@')) },
      });
      await profile.createFor(tx, user.id);
    });
    console.log(`Seeded ${label.toLowerCase()} account: ${email} (sign in with ${codeVar})`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
