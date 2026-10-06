import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS } from './index.js';

describe('payouts R2 — logs never carry bank details', () => {
  it('redacts PAN and account numbers wherever they appear', () => {
    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, { write: (l: string) => lines.push(l) });
    log.info({ input: { pan: 'ABCPS1234K', accountNumber: '51234567890' }, body: { beneficiaryAccountNumber: '51234567890' } });
    log.info({ pan: 'ABCPS1234K', accountNumber: '51234567890' });
    expect(lines.join('')).not.toMatch(/ABCPS1234K|51234567890/);
  });
});
