/**
 * Composition root (architecture.md §2).
 *
 * Express hosts six things: the GraphQL endpoint, three signed webhooks
 * (Resend, Razorpay payments, RazorpayX payouts), the browser leg of a
 * Razorpay checkout, the Pusher channel authorizer, and health checks. That
 * list is closed — new features arrive as GraphQL fields, never as new routes.
 *
 * ORDER MATTERS. Read the comments before reordering anything.
 */
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';

import { config, isProd, silentTransports } from './platform/config.js';
import { logger } from './platform/logging/index.js';
import { db, disconnectDb } from './platform/db.js';
import { closeQueues } from './platform/queue.js';
import { resendWebhook } from './platform/webhooks/resend.js';
import { paymentsWebhook } from './platform/webhooks/payments.js';
import { payoutsWebhook } from './platform/webhooks/payouts.js';
import { razorpay } from './platform/paymentGateway.js';
import { createRazorpayCheckoutRouter } from './platform/webhooks/razorpayCheckout.js';
import { pusherAuthRoute } from './platform/realtime/auth.js';
import { buildContext, type Ctx } from './graphql/context.js';
import { schema } from './schema.js';

export async function createApp() {
  for (const warning of silentTransports()) logger.warn(warning);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the platform load balancer
  app.use(helmet({ contentSecurityPolicy: isProd }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  // ── Signed webhooks receive the RAW body ─────────────────────────────────
  // Both providers sign the exact bytes they transmitted. These routes MUST be
  // mounted before express.json(), or verification fails silently forever —
  // and presents as a credentials problem, which is how teams lose a day.
  app.post(
    '/webhooks/resend',
    express.raw({ type: '*/*' }),
    (req, res, next) => {
      resendWebhook(req, res).catch(next);
    },
  );
  app.post(
    '/webhooks/payments',
    express.raw({ type: '*/*' }),
    (req, res, next) => {
      paymentsWebhook(req, res).catch(next);
    },
  );
  // payouts R13 — RazorpayX signs the raw body too.
  app.post(
    '/webhooks/payouts',
    express.raw({ type: '*/*' }),
    (req, res, next) => {
      payoutsWebhook(req, res).catch(next);
    },
  );

  // The browser leg of a Razorpay payment: the checkout page the app opens,
  // and the return Razorpay posts the player back to. No state change —
  // payments R5 — so it needs no raw body, only the page and the verifier.
  app.use(createRazorpayCheckoutRouter(razorpay));

  app.use(express.json({ limit: '256kb' }));

  // ── Pusher channel authorizer ────────────────────────────────────────────
  // pusher-js posts form-encoded socket_id/channel_name. Entitlement is
  // re-checked on every call; see platform/realtime/auth.ts.
  app.post(
    '/pusher/auth',
    express.urlencoded({ extended: false, limit: '4kb' }),
    (req, res, next) => {
      pusherAuthRoute(req, res).catch(next);
    },
  );

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get('/readyz', (_req, res) => {
    void (async () => {
      try {
        await db.$queryRaw`SELECT 1`;
        res.status(200).json({ ok: true, postgres: true });
      } catch (err) {
        logger.error({ err }, 'readiness check failed');
        res.status(503).json({ ok: false });
      }
    })();
  });

  // ── GraphQL ──────────────────────────────────────────────────────────────
  const apollo = new ApolloServer<Ctx>({
    schema,
    // conventions.md §4 — the committed SDL is the contract; the endpoint need
    // not publish it.
    introspection: !isProd,
    includeStacktraceInErrorResponses: !isProd,
  });
  await apollo.start();

  app.use(
    '/graphql',
    cors({
      origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : true,
      credentials: true,
    }),
    expressMiddleware(apollo, {
      context: async ({ req }) => buildContext({ req }),
    }),
  );

  // Error middleware is last, always.
  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ err, url: req.originalUrl }, 'unhandled error');
      res.status(500).json({ error: 'INTERNAL' });
    },
  );

  return { app, apollo };
}

async function main(): Promise<void> {
  const { app, apollo } = await createApp();
  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      `PL4Y API listening — GraphQL at http://localhost:${config.PORT}/graphql`,
    );
  });

  const shutdown = (signal: string) => {
    void (async () => {
      logger.info({ signal }, 'shutting down');
      server.close();
      await apollo.stop();
      await closeQueues();
      await disconnectDb();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only run when executed directly, so tests can import createApp().
// pathToFileURL, not string surgery: on Windows import.meta.url is
// file:///C:/... while a hand-built file:// prefix has one slash too few.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch((err) => {
    logger.fatal({ err }, 'failed to start');
    process.exit(1);
  });
}
