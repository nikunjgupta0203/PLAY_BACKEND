/**
 * API and worker in ONE process — for hosts that cannot run a second process
 * (Render's free plan has no background workers).
 *
 * Same code as `app.ts` and `worker.ts`, one shutdown path: both share the db
 * and the queue runtime, so they are closed once, after both halves have
 * stopped. When the plan allows it, run the two entrypoints separately instead
 * (architecture.md §1): job work then no longer competes with request latency.
 */
import { logger } from './platform/logging/index.js';
import { config } from './platform/config.js';
import { disconnectDb } from './platform/db.js';
import { closeQueues } from './platform/queue.js';
import { createApp } from './app.js';
import { startWorkers } from './worker.js';

async function main(): Promise<void> {
  const { app, apollo } = await createApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'PL4Y API + worker listening');
  });
  const stopDrain = await startWorkers();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      logger.info({ signal }, 'shutting down');
      server.close();
      stopDrain();
      await apollo.stop();
      await closeQueues();
      await disconnectDb();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
