import pino from 'pino';
import { config, isProd } from '../config.js';

/**
 * Never log secrets. identity R1: an OTP code must not reach any log line.
 * payouts R2 adds the bank details.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.code',
  '*.codeHash',
  '*.token',
  '*.refreshToken',
  '*.tokenHash',
  '*.password',
  'password',
  'code',
  'token',
  'pan',
  '*.pan',
  'accountNumber',
  '*.accountNumber',
  'beneficiaryAccountNumber',
  '*.beneficiaryAccountNumber',
  '*[*].beneficiaryAccountNumber',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
});

export type Logger = typeof logger;

/**
 * The request id rides into every job enqueued during a request, so a support
 * ticket about one registration traces end to end (conventions.md §8).
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
}
