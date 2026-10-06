/**
 * RazorpayX behind the PayoutProvider port. `fetch`, no SDK. The ONLY file
 * that holds the RazorpayX key secret and payouts webhook secret.
 *
 * Endpoints and payloads are from razorpay.com/docs/api/x (checked
 * 2026-10-03) and are confirmed against test mode by
 * scripts/razorpayx-probe.ts; where the probe disagrees with this file, the
 * probe wins and this file changes.
 *
 *  - The bank check is the composite Account Validation API: contact, fund
 *    account and penny test in one call. It answers `created` and finishes
 *    within seconds, so the call waits a little for the answer; one that is
 *    still running comes back `pending` and the service asks again later.
 *  - A transfer is a composite payout. RazorpayX requires an idempotency key
 *    (X-Payout-Idempotency) on every payout; ours is derived from the ref, so
 *    a resend of the same transfer can never pay twice. `queue_if_low_balance`
 *    parks it rather than failing it when the balance runs short between our
 *    check and the debit.
 *  - Status is looked up by our ref (`reference_id`), never taken from a
 *    webhook (payouts R13). Webhooks are signed, and still only say which.
 */
import { GatewayError } from '../gatewayError.js';
import { clean, header, hmacHex, shortToken, signatureMatches, toInt, toPaise } from '../razorpay/signature.js';
import type { AccountCheck, PayoutProvider, TransferState, TransferStatus } from './port.js';

const API = 'https://api.razorpay.com/v1';
/** A call gives up after 10 s so the job retries rather than hangs. */
const TIMEOUT_MS = 10_000;
/** How long verifyAccount waits for a penny test: 5 × 2 s. */
const VALIDATION_POLLS = 5;
const VALIDATION_POLL_MS = 2_000;

const STATES: Record<string, TransferState> = {
  processed: 'success',
  reversed: 'reversed',
  failed: 'failed',
  rejected: 'failed',
  cancelled: 'failed',
  queued: 'pending',
  pending: 'pending',
  processing: 'pending',
};

interface RzpError {
  error?: { description?: unknown; field?: unknown };
}

interface Validation {
  id?: unknown;
  status?: unknown;
  validation_results?: {
    account_status?: unknown;
    registered_name?: unknown;
    name_match_score?: unknown;
    details?: unknown;
  } | null;
  status_details?: { description?: unknown } | null;
}

interface Payout {
  id?: unknown;
  status?: unknown;
  reference_id?: unknown;
  status_details?: { description?: unknown } | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Names as RazorpayX takes them: letters, digits, space and ' - _ / ( ) . only.
 * Accents are folded (Zoë → Zoe) rather than dropped, so the bank's name
 * match still has the whole name to compare.
 */
export function payeeName(name: string, max: number): string {
  return clean(
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 '\-_/().]/g, ' '),
    max,
  );
}

/** A contact's name is 3–50 characters; one too short to send is labelled instead. */
const contactName = (name: string): string => {
  const n = payeeName(name, 50);
  return n.length >= 3 ? n : 'PL4Y host';
};

/** A bank statement narration: letters, digits and space, 30 at most. */
const narration = (s: string): string => clean(s.replace(/[^A-Za-z0-9 ]/g, ' '), 30);

/** A 400 about the host's own bank details, which no retry will fix. */
const isBankDetailsError = (field: unknown): boolean =>
  typeof field === 'string' && field !== 'source_account_number' && /(^|\.)(ifsc|account_number)$/.test(field);

function toCheck(v: Validation): AccountCheck {
  const r = v.validation_results ?? {};
  const failure = str(r.details) ?? str(v.status_details?.description);
  if (v.status !== 'completed') {
    // `created` is still running; `failed` is a technical failure at a bank
    // ("retry after 30 min"), not an answer about the account.
    return { outcome: 'pending', nameAtBank: null, nameMatch: null, error: v.status === 'failed' ? failure : null };
  }
  if (r.account_status !== 'active' && r.account_status !== 'valid') {
    return { outcome: 'missing', nameAtBank: null, nameMatch: null, error: failure };
  }
  const score = typeof r.name_match_score === 'string' ? Number(r.name_match_score) : r.name_match_score;
  return {
    outcome: 'exists',
    nameAtBank: str(r.registered_name),
    nameMatch: typeof score === 'number' && Number.isFinite(score) ? Math.round(score) : null,
    error: null,
  };
}

export function createRazorpayXPayouts(opts: {
  keyId: string;
  keySecret: string;
  /** The RazorpayX account payouts are debited from. */
  accountNumber: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): PayoutProvider {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const authorization = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`;

  /** One call, answered as status and body. Only an unreachable API throws. */
  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayError(503, `RazorpayX unreachable: ${(err as Error).message}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Left null: the status says what happened.
    }
    return { status: res.status, body: json };
  }

  const errorText = (body: unknown, status: number): string =>
    str((body as RzpError | null)?.error?.description) ?? `HTTP ${status}`;

  /** For calls where any refusal is ours to retry, not an answer. */
  async function api<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    const res = await request(method, path);
    if (res.status < 200 || res.status >= 300 || res.body === null) {
      throw new GatewayError(res.status >= 500 ? 503 : 502, `RazorpayX ${method} ${path.split('?')[0]}: ${errorText(res.body, res.status)}`);
    }
    return res.body as T;
  }

  return {
    name: 'razorpayx',

    async verifyAccount(input): Promise<AccountCheck> {
      const name = payeeName(input.name, 120);
      const res = await request('POST', '/fund_accounts/validations', {
        source_account_number: opts.accountNumber,
        validation_type: 'optimized',
        reference_id: input.ref,
        fund_account: {
          account_type: 'bank_account',
          // The name the bank's record is matched against (name_match_score).
          // Optional to RazorpayX, and refused under 4 characters: left out then.
          bank_account: {
            ...(name.length >= 4 ? { name } : {}),
            ifsc: input.ifsc,
            account_number: input.accountNumber,
          },
          contact: { name: contactName(input.name), type: 'vendor', reference_id: input.ref },
        },
      });
      if (res.status === 400 && isBankDetailsError((res.body as RzpError | null)?.error?.field)) {
        return { outcome: 'missing', nameAtBank: null, nameMatch: null, error: errorText(res.body, res.status) };
      }
      if (res.status < 200 || res.status >= 300 || res.body === null) {
        throw new GatewayError(res.status >= 500 ? 503 : 502, `RazorpayX validation: ${errorText(res.body, res.status)}`);
      }
      let v = res.body as Validation;
      const id = str(v.id);
      for (let i = 0; id && v.status === 'created' && i < VALIDATION_POLLS; i += 1) {
        await sleep(VALIDATION_POLL_MS);
        v = await api<Validation>('GET', `/fund_accounts/validations/${encodeURIComponent(id)}`);
      }
      return toCheck(v);
    },

    async availablePaise() {
      const body = await api<{ items?: { account_number?: unknown; available_amount?: unknown; amount?: unknown }[] }>(
        'GET',
        '/banking_balances',
      );
      const items = body.items ?? [];
      // Matched on our source account; a business with a single account may
      // see it listed under another number, so a lone account is taken as it.
      const mine = items.find((i) => i.account_number === opts.accountNumber) ?? (items.length === 1 ? items[0] : undefined);
      if (!mine) throw new GatewayError(503, 'RazorpayX lists no balance for RAZORPAYX_ACCOUNT_NUMBER');
      return toPaise(mine.available_amount ?? mine.amount);
    },

    async transfer(input) {
      const res = await request(
        'POST',
        '/payouts',
        {
          account_number: opts.accountNumber,
          amount: toInt(input.amountPaise),
          currency: 'INR',
          mode: input.mode,
          // RazorpayX takes a fixed set of purposes; ours is the narration.
          purpose: 'payout',
          fund_account: {
            account_type: 'bank_account',
            bank_account: { name: payeeName(input.name, 120), ifsc: input.ifsc, account_number: input.accountNumber },
            contact: { name: contactName(input.name), type: 'vendor' },
          },
          queue_if_low_balance: true,
          reference_id: input.ref,
          narration: narration(input.purpose),
        },
        { 'X-Payout-Idempotency': shortToken(`payout:${input.ref}`, 36) },
      );
      if (res.status >= 200 && res.status < 300) return { accepted: true, error: null };
      // A 400 is RazorpayX refusing this payout (bad IFSC, amount): nothing was
      // created. Anything else may or may not have been — the status check decides.
      if (res.status === 400) return { accepted: false, error: errorText(res.body, res.status) };
      throw new GatewayError(res.status >= 500 ? 503 : 502, `RazorpayX payout: ${errorText(res.body, res.status)}`);
    },

    async transferStatus(ref): Promise<TransferStatus> {
      const q = new URLSearchParams({ account_number: opts.accountNumber, reference_id: ref, count: '10' });
      const body = await api<{ items?: Payout[] }>('GET', `/payouts?${q.toString()}`);
      // An empty list means "not determined", never "failed".
      const row = body.items?.find((p) => p.reference_id === ref);
      const status = str(row?.status);
      if (!row || !status) return { state: 'unknown', providerStatus: null, providerRef: null, message: null };
      return {
        state: STATES[status] ?? 'pending',
        providerStatus: status,
        providerRef: str(row.id),
        message: str(row.status_details?.description),
      };
    },

    refFromWebhook(raw, headers) {
      if (!signatureMatches(hmacHex(opts.webhookSecret, raw), header(headers, 'x-razorpay-signature'))) return null;
      let body: { event?: unknown; payload?: { payout?: { entity?: Payout } } } | null;
      try {
        body = JSON.parse(raw.toString('utf8')) as typeof body;
      } catch {
        return null;
      }
      if (typeof body?.event !== 'string' || !body.event.startsWith('payout.')) return null;
      const ref = body.payload?.payout?.entity?.reference_id;
      return typeof ref === 'string' && ref.length > 0 && ref.length <= 40 ? ref : null;
    },
  };
}
