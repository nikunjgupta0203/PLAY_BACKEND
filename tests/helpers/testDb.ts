/**
 * A real Postgres for service tests (conventions.md §5).
 *
 * A mocked database is banned here: our correctness lives in constraints —
 * unique partial indexes, FOR UPDATE, advisory locks — and a mock hides exactly
 * the bugs that matter.
 *
 * Locally this spins a Testcontainers postgis image. In CI, set
 * TEST_DATABASE_URL to a Neon branch (ADR 0001) and no container is started.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

const IMAGE = 'postgis/postgis:16-3.4';

let container: StartedPostgreSqlContainer | undefined;
let client: PrismaClient | undefined;
let url: string | undefined;

export async function startTestDb(): Promise<{ prisma: PrismaClient; url: string }> {
  if (client && url) return { prisma: client, url };

  const provided = process.env.TEST_DATABASE_URL;

  if (provided) {
    url = provided;
  } else {
    container = await startContainer();
    url = container.getConnectionUri();
  }

  // The postgis image preinstalls companion extensions Prisma reads as drift.
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$executeRawUnsafe('DROP EXTENSION IF EXISTS postgis_tiger_geocoder CASCADE');
  await admin.$executeRawUnsafe('DROP EXTENSION IF EXISTS postgis_topology CASCADE');
  await admin.$executeRawUnsafe('DROP EXTENSION IF EXISTS fuzzystrmatch CASCADE');
  await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS tiger CASCADE');
  await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS tiger_data CASCADE');
  await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS topology CASCADE');
  await admin.$executeRawUnsafe('DROP EXTENSION IF EXISTS postgis CASCADE');
  await admin.$disconnect();

  // Invoke the CLI entrypoint with node rather than the .bin shim: on Windows
  // execFileSync refuses to spawn a .cmd without a shell (EINVAL).
  execFileSync(
    process.execPath,
    [createRequire(import.meta.url).resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
      stdio: 'pipe',
    },
  );

  client = new PrismaClient({ datasources: { db: { url } } });
  await client.$connect();
  return { prisma: client, url };
}

/**
 * A cold Docker daemon, or a container that reports unhealthy on its first
 * health check, used to fail the whole test file before any test ran. Give the
 * container a longer startup wait and retry a couple of times before giving up.
 */
async function startContainer(attempts = 3): Promise<StartedPostgreSqlContainer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await new PostgreSqlContainer(IMAGE)
        .withDatabase('pl4y_test')
        .withUsername('pl4y')
        .withPassword('pl4y')
        .withStartupTimeout(120_000)
        .start();
    } catch (e) {
      lastError = e;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
  throw lastError;
}

export async function stopTestDb(): Promise<void> {
  await client?.$disconnect();
  await container?.stop();
  client = undefined;
  container = undefined;
  url = undefined;
}

/** Truncate every application table between tests. Order-independent. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename NOT LIKE '_prisma%'
       AND tablename NOT IN ('spatial_ref_sys')
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
