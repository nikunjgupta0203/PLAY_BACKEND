import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRazorpayXPayouts, payeeName } from './razorpayx.js';
import { GatewayError } from './port.js';

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
type Reply = { status?: number; body: unknown } | Error;

const SOURCE = '7878780080316316';
const WEBHOOK_SECRET = 'x-webhook-secret';

/** Answers by path (query string ignored), each path's replies in turn. */
function fakeFetch(responses: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    const key = `${init.method ?? 'GET'} ${path}`;
    const next = responses[key]?.shift();
    if (next === undefined) throw new Error(`no fake response for ${key}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const bank = { accountNumber: '765432123456789', ifsc: 'HDFC0000053', name: 'Rahul Sharma' };

const make = (responses: Record<string, Reply[]>) => {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const provider = createRazorpayXPayouts({
    keyId: 'rzp_test_x',
    keySecret: 'x-secret',
    accountNumber: SOURCE,
    webhookSecret: WEBHOOK_SECRET,
    fetch: f.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { provider, calls: f.calls, sleeps };
};

/** Razorpay's documented validation entity, as each state answers. */
const validation = (status: string, results: Record<string, unknown>, statusDescription = 'x') => ({
  id: 'fav_00000000000001',
  entity: 'fund_account.validation',
  status,
  validation_results: { account_status: null, registered_name: null, details: null, name_match_score: null, ...results },
  status_details: { description: statusDescription, source: 'beneficiary_bank', reason: 'r' },
  reference_id: 'v-1',
});

const COMPLETED = validation('completed', {
  account_status: 'active',
  registered_name: 'RAHUL SHARMA',
  details: 'The beneficiary account is valid.',
  name_match_score: 96.4,
});

describe('RazorpayX payouts adapter — bank check', () => {
  it('validates through the composite API and reports the bank name and score', async () => {
    const { provider, calls } = make({ 'POST /fund_accounts/validations': [{ body: COMPLETED }] });
    const check = await provider.verifyAccount({ ...bank, ref: 'v-1' });
    expect(check).toEqual({ outcome: 'exists', nameAtBank: 'RAHUL SHARMA', nameMatch: 96, error: null });
    expect(calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_x:x-secret').toString('base64')}`);
    expect(calls[0]!.body).toEqual({
      source_account_number: SOURCE,
      validation_type: 'optimized',
      reference_id: 'v-1',
      fund_account: {
        account_type: 'bank_account',
        bank_account: { name: 'Rahul Sharma', ifsc: 'HDFC0000053', account_number: '765432123456789' },
        contact: { name: 'Rahul Sharma', type: 'vendor', reference_id: 'v-1' },
      },
    });
  });

  it('waits for a validation that is still running', async () => {
    const { provider, calls, sleeps } = make({
      'POST /fund_accounts/validations': [{ body: validation('created', {}) }],
      'GET /fund_accounts/validations/fav_00000000000001': [{ body: validation('created', {}) }, { body: COMPLETED }],
    });
    expect((await provider.verifyAccount({ ...bank, ref: 'v-1' })).outcome).toBe('exists');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('one that never finishes is pending, for the service to ask again', async () => {
    const created = () => ({ body: validation('created', {}) });
    const { provider, calls } = make({
      'POST /fund_accounts/validations': [created()],
      'GET /fund_accounts/validations/fav_00000000000001': [created(), created(), created(), created(), created()],
    });
    expect(await provider.verifyAccount({ ...bank, ref: 'v-1' })).toEqual({
      outcome: 'pending',
      nameAtBank: null,
      nameMatch: null,
      error: null,
    });
    expect(calls).toHaveLength(6);
  });

  it('an invalid account is missing, with the reason', async () => {
    const { provider } = make({
      'POST /fund_accounts/validations': [
        { body: validation('completed', { account_status: 'invalid', details: 'Beneficiary account is invalid.' }) },
      ],
    });
    expect(await provider.verifyAccount({ ...bank, ref: 'v-1' })).toEqual({
      outcome: 'missing',
      nameAtBank: null,
      nameMatch: null,
      error: 'Beneficiary account is invalid.',
    });
  });

  it("a bank's technical failure is pending, not a verdict on the account", async () => {
    const { provider } = make({
      'POST /fund_accounts/validations': [
        { body: validation('failed', { account_status: '' }, 'Validation failed due to a temporary technical issue at the partner bank. Please retry after 30 min.') },
      ],
    });
    const check = await provider.verifyAccount({ ...bank, ref: 'v-1' });
    expect(check.outcome).toBe('pending');
    expect(check.error).toContain('temporary technical issue');
  });

  it('an IFSC RazorpayX refuses is the host’s to fix', async () => {
    const { provider } = make({
      'POST /fund_accounts/validations': [
        { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Invalid IFSC Code in Bank Account', field: 'ifsc' } } },
      ],
    });
    expect(await provider.verifyAccount({ ...bank, ref: 'v-1' })).toMatchObject({
      outcome: 'missing',
      error: 'Invalid IFSC Code in Bank Account',
    });
  });

  it('a refusal about our own account is an error to retry, never a verdict on the host', async () => {
    const { provider } = make({
      'POST /fund_accounts/validations': [
        { status: 400, body: { error: { description: 'The source account number is invalid', field: 'source_account_number' } } },
      ],
    });
    await expect(provider.verifyAccount({ ...bank, ref: 'v-1' })).rejects.toBeInstanceOf(GatewayError);
  });

  it('a name too short for RazorpayX leaves the bank name out', async () => {
    const { provider, calls } = make({ 'POST /fund_accounts/validations': [{ body: COMPLETED }] });
    await provider.verifyAccount({ ...bank, name: 'Om', ref: 'v-1' });
    const fundAccount = calls[0]!.body!['fund_account'] as { bank_account: object; contact: { name: string } };
    expect(fundAccount.bank_account).not.toHaveProperty('name');
    expect(fundAccount.contact.name).toBe('PL4Y host');
  });
});

describe('RazorpayX payouts adapter — balance and transfers', () => {
  it('reads the available balance of our source account', async () => {
    const { provider } = make({
      'GET /banking_balances': [
        {
          body: {
            entity: 'collection',
            items: [
              { account_number: '409001396356', available_amount: 1, amount: 1 },
              { account_number: SOURCE, available_amount: 186682638, amount: 186682639 },
            ],
          },
        },
      ],
    });
    expect(await provider.availablePaise()).toBe(186682638n);
  });

  it('no balance for our account is an error, never zero', async () => {
    const { provider } = make({
      'GET /banking_balances': [{ body: { items: [{ account_number: 'a', amount: 1 }, { account_number: 'b', amount: 2 }] } }],
    });
    await expect(provider.availablePaise()).rejects.toBeInstanceOf(GatewayError);
  });

  it('sends a composite payout with an idempotency key derived from the ref', async () => {
    const payout = { id: 'pout_1', entity: 'payout', status: 'processing', reference_id: 'p-1' };
    const { provider, calls } = make({ 'POST /payouts': [{ body: payout }, { body: payout }] });
    const send = { ...bank, ref: 'p-1', amountPaise: 94_050n, mode: 'IMPS' as const, purpose: 'PL4Y host payout' };
    expect(await provider.transfer(send)).toEqual({ accepted: true, error: null });
    await provider.transfer(send);

    const key = calls[0]!.headers['X-Payout-Idempotency']!;
    expect(key).toMatch(/^[0-9a-f]{36}$/);
    expect(calls[1]!.headers['X-Payout-Idempotency']).toBe(key);
    expect(calls[0]!.body).toEqual({
      account_number: SOURCE,
      amount: 94050,
      currency: 'INR',
      mode: 'IMPS',
      purpose: 'payout',
      fund_account: {
        account_type: 'bank_account',
        bank_account: { name: 'Rahul Sharma', ifsc: 'HDFC0000053', account_number: '765432123456789' },
        contact: { name: 'Rahul Sharma', type: 'vendor' },
      },
      queue_if_low_balance: true,
      reference_id: 'p-1',
      narration: 'PL4Y host payout',
    });
  });

  it('a 400 is a refusal: nothing was created', async () => {
    const { provider } = make({
      'POST /payouts': [{ status: 400, body: { error: { description: 'Invalid IFSC Code in Bank Account', field: 'ifsc' } } }],
    });
    expect(await provider.transfer({ ...bank, ref: 'p-1', amountPaise: 100n, mode: 'NEFT', purpose: 'x' })).toEqual({
      accepted: false,
      error: 'Invalid IFSC Code in Bank Account',
    });
  });

  it('a 5xx or a timeout is an unknown outcome (throws), for the status check to settle', async () => {
    const { provider } = make({ 'POST /payouts': [{ status: 502, body: { error: { description: 'bad gateway' } } }, new TypeError('timeout')] });
    const send = { ...bank, ref: 'p-1', amountPaise: 100n, mode: 'NEFT' as const, purpose: 'x' };
    await expect(provider.transfer(send)).rejects.toBeInstanceOf(GatewayError);
    await expect(provider.transfer(send)).rejects.toBeInstanceOf(GatewayError);
  });

  it.each([
    ['processed', 'success'],
    ['processing', 'pending'],
    ['queued', 'pending'],
    ['pending', 'pending'],
    ['rejected', 'failed'],
    ['cancelled', 'failed'],
    ['failed', 'failed'],
    ['reversed', 'reversed'],
  ])('maps payout status %s to %s, looked up by our ref', async (status, state) => {
    const { provider, calls } = make({
      'GET /payouts': [
        {
          body: {
            entity: 'collection',
            items: [{ id: 'pout_1', status, reference_id: 'p-1', status_details: { description: 'd', source: 's', reason: 'r' } }],
          },
        },
      ],
    });
    expect(await provider.transferStatus('p-1')).toEqual({ state, providerStatus: status, providerRef: 'pout_1', message: 'd' });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('account_number')).toBe(SOURCE);
    expect(url.searchParams.get('reference_id')).toBe('p-1');
  });

  it('a payout RazorpayX does not list is unknown, never failed', async () => {
    const { provider } = make({ 'GET /payouts': [{ body: { entity: 'collection', count: 0, items: [] } }] });
    expect((await provider.transferStatus('p-1')).state).toBe('unknown');
  });
});

describe('RazorpayX payouts adapter — webhooks', () => {
  const signed = (body: object, secret = WEBHOOK_SECRET) => {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, headers: { 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex') } };
  };
  const processed = { entity: 'event', event: 'payout.processed', payload: { payout: { entity: { id: 'pout_1', reference_id: 'p-1', status: 'processed' } } } };

  it('names the ref of a signed payout event, and nothing else', () => {
    const { provider } = make({});
    const { raw, headers } = signed(processed);
    expect(provider.refFromWebhook(raw, headers)).toBe('p-1');
  });

  it('an unsigned or wrongly signed body names nothing', () => {
    const { provider } = make({});
    expect(provider.refFromWebhook(signed(processed).raw, {})).toBeNull();
    const forged = signed(processed, 'not-the-secret');
    expect(provider.refFromWebhook(forged.raw, forged.headers)).toBeNull();
  });

  it('events that are not about a payout name nothing', () => {
    const { provider } = make({});
    const { raw, headers } = signed({ event: 'fund_account.validation.completed', payload: {} });
    expect(provider.refFromWebhook(raw, headers)).toBeNull();
  });
});

describe('payeeName', () => {
  it('folds accents and drops what RazorpayX refuses', () => {
    expect(payeeName('Zoë  D’Souza & Co.', 120)).toBe('Zoe D Souza Co.');
    expect(payeeName("Ravi O'Neil-Kumar (HUF)", 120)).toBe("Ravi O'Neil-Kumar (HUF)");
  });
});
