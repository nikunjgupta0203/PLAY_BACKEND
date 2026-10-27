/**
 * Keeps one failed promise from taking the whole server down.
 *
 * Node 22 exits on an unhandled promise rejection. Most of those here are a
 * background call that hit the database while Neon was briefly unreachable:
 * Prisma reconnects on the next query, so logging and carrying on is right.
 * Exiting would drop every API request and every running job with it.
 *
 * A synchronous uncaught exception is different: the code that threw may have
 * left state half-changed, and Node's advice is not to resume. We log it and
 * exit, and Render restarts the service.
 */
import { logger } from './logging/index.js';

let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection (process kept running)');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception, exiting');
    // Give pino a moment to flush before the process goes.
    setTimeout(() => process.exit(1), 100).unref();
  });
}
