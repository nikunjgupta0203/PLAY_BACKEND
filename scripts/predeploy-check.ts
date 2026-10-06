/**
 * Read-only checks to run against PRODUCTION before a deploy
 * (PLAY_FRONTEND/docs/backlog/remaining-work.md §1). Writes nothing.
 *
 *   DATABASE_URL=<prod> pnpm predeploy:check --portal-url https://admin.example.com
 *
 * Exits 1 when something would break the deploy or the portal, 0 otherwise.
 *
 * 1. Which migrations production has not run yet.
 * 2. Migration 034 updates every open draw, and 033's NOT VALID check refuses a
 *    draw whose minimum entries is above its capacity: any such draw makes 034
 *    fail and the deploy stop. Fix them first (the query to do it is printed).
 * 3. Whether there is a first admin for the portal.
 * 4. Whether CORS_ORIGINS lets the portal call the API.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const portalUrl = (() => {
  const i = args.indexOf('--portal-url');
  return i >= 0 ? args[i + 1]?.replace(/\/$/, '') : undefined;
})();

const db = new PrismaClient();
let failed = false;
const pass = (msg: string) => console.log(`  ✔ ${msg}`);
const fail = (msg: string) => {
  failed = true;
  console.log(`  ✘ ${msg}`);
};
const note = (msg: string) => console.log(`    ${msg}`);

async function main(): Promise<void> {
  console.log('PL4Y pre-deploy check (read-only)\n');

  // 1 — migrations
  console.log('Migrations');
  const local = readdirSync(join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  let applied = new Set<string>();
  try {
    const rows = await db.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
    applied = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
    const broken = rows.filter((r) => !r.finished_at && !r.rolled_back_at);
    for (const b of broken) fail(`${b.migration_name} started and never finished — resolve it before deploying (prisma migrate resolve)`);
  } catch {
    fail('could not read _prisma_migrations — is DATABASE_URL pointing at the right database?');
  }
  const pending = local.filter((m) => !applied.has(m));
  if (pending.length === 0) pass('production has every migration');
  else {
    pass(`${pending.length} to run on deploy:`);
    for (const m of pending) note(`· ${m}`);
  }

  // 2 — the 034 trap
  console.log('\nDraws that would stop migration 034');
  const needs034 = pending.some((m) => m.endsWith('_034_no_gst'));
  const bad = await db.$queryRaw<{ id: string; name: string; capacity: number; min_entries: number; status: string }[]>`
    SELECT id::text, name, capacity, min_entries, status
      FROM event_categories
     WHERE min_entries > capacity AND status IN ('open', 'full')`;
  if (bad.length === 0) pass('none');
  else if (!needs034) pass(`${bad.length} draw(s) have min_entries > capacity, but 034 already ran — not a deploy blocker`);
  else {
    fail(`${bad.length} open draw(s) have min_entries above capacity; 034 will fail on them:`);
    for (const r of bad) note(`· ${r.id}  "${r.name}"  capacity ${r.capacity}, minimum ${r.min_entries}`);
    note('Fix with:');
    note("UPDATE event_categories SET min_entries = capacity WHERE min_entries > capacity AND status IN ('open','full');");
  }

  // 3 — the first admin
  console.log('\nPortal staff');
  try {
    const admins = await db.platformStaff.count({ where: { role: 'admin' } });
    if (admins > 0) pass(`${admins} admin(s)`);
    else {
      fail('nobody is an admin yet');
      note('Sign in to the app once with the admin’s email, then: pnpm admin:grant <email> admin');
    }
  } catch {
    note('platform_staff does not exist yet (migration 035/036 pending) — grant the first admin after deploying.');
  }

  // 4 — CORS for the portal
  console.log('\nCORS for the admin portal');
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (!portalUrl) note('pass --portal-url <https://admin…> to check it');
  else if (origins.length === 0) pass('CORS_ORIGINS is empty here, which allows every origin (check the value set on the server)');
  else if (origins.includes(portalUrl)) pass(`${portalUrl} is allowed`);
  else fail(`${portalUrl} is not in CORS_ORIGINS — the browser will block every portal request`);

  console.log(failed ? '\nNot ready: fix the ✘ items first.' : '\nReady to deploy.');
}

main()
  .catch((err) => {
    console.error(err);
    failed = true;
  })
  .finally(async () => {
    await db.$disconnect();
    process.exit(failed ? 1 : 0);
  });
