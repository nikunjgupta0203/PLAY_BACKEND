# Host Verification and Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts add a bank account, are verified by a PayU penny test plus offline PAN checks, can then publish paid categories, and receive their share by IMPS 72 h after the event ends.

**Architecture:** Everything lives in the `payments` module as a second service (`createPayoutsService`) beside the existing one, so the 1,182-line payments service is not touched beyond one export. PayU Payouts sits behind a new `PayoutProvider` port in `src/platform/payouts/`, mirroring `paymentGateway.ts`. Pure units (PAN checks, the quote, the secret box, the verification decision) are tested without a database; the service is tested against real Postgres with a fake provider, like `tests/payments.test.ts`.

**Tech Stack:** TypeScript (ESM), Prisma 6 + Postgres, Pothos GraphQL, Vitest + Testcontainers, Postgres job queue (`src/platform/queue.ts`), `fetch` (no PayU SDK).

**Spec:** `docs/superpowers/specs/2026-10-02-host-payouts-design.md` — read it before starting. Rule numbers below (R1–R16) are the spec's.

**Scope:** backend only. The app screens (`PLAY_FRONTEND` module `22-host`: *Get paid*, status card, payout on the manage screen) get their own plan once this branch's GraphQL is merged, because the app is built against `schema.graphql`.

## Global Constraints

- Money is `bigint` paise everywhere; no float touches money (conventions.md §2). PayU's rupee amounts are converted with `toPaise`/`toRupees` from `src/platform/payu/hash.ts`.
- Rounding is half-up in integers: `(x * bps + 5000n) / 10000n`.
- `HOST_COMMISSION_BPS = 1000` is already frozen per category in `event_categories.commission_bps`; read it from there, never from the constant.
- PAN and account number are encrypted (AES-256-GCM, `PAYOUT_DATA_KEY`, 32 bytes base64) and never returned by GraphQL or logged.
- Penny-test auto-verify threshold: `PAYOUT_NAME_MATCH_AUTO`, default **80**.
- Settlement delay: **72 h** after `events.ends_at`.
- NEFT above `PAYOUT_IMPS_MAX_PAISE`, default **50,000,000 paise (₹5,00,000)**; IMPS otherwise.
- Verification retry delays when PayU says pending or errors: **5 min, 30 min, 2 h**, then `needs_review`.
- Bank detail saves: **5 per user per day**.
- `COMMISSION_GST_BPS` and `HOST_TDS_BPS` have no production default: the server refuses to start with `PAYOUT_PROVIDER=payu` in production unless both are set.
- PayU `merchantRefId` ≤ 40 characters.
- Staff decisions: `admin` or `finance`; `support` may read the review queue only.
- Comments explain *why*, cite the rule (`payouts R9`), and match the surrounding density.
- Run `pnpm test`, `pnpm typecheck`, `pnpm lint` before every commit that touches `src/`.

## Review Focus

1. **A transfer whose outcome is unknown (timeout after PayU accepted it).** Expect: the payout stays `sending`, the next status check finds it, and it is never sent twice. — pinned in Task 7 (`timeout after acceptance sends once`).
2. **Two sweeps settling the same payout at once.** Expect: exactly one moves it to `sending`. — pinned in Task 7 (`concurrent sends`).
3. **A refund processed after the host was paid.** Expect: a `host_receivable` equal to the refunded entry fee less its commission, netted from the next payout. — pinned in Task 7.
4. **A host changes bank details while a payout is due.** Expect: the payout is held `account_not_verified`, not sent to the old or unverified account, and released after re-verification. — pinned in Task 7.
5. **Lower-case or space-padded PAN/IFSC input.** Expect: normalised to upper case and trimmed, not rejected. — pinned in Task 2.

---

## File map

| File | Responsibility |
|---|---|
| `src/platform/config.ts` (modify) | Payout config keys and refinements |
| `src/platform/crypto/secretBox.ts` (create) | AES-256-GCM seal/open |
| `src/modules/payments/service/pan.ts` (create) | PAN, IFSC, account-number checks (R1, R4) |
| `prisma/migrations/20261002100000_032_host_payouts/migration.sql` (create) | Tables, CHECKs, ledger kinds |
| `prisma/schema.prisma` (modify) | `PayoutAccount`, `Payout`, `LedgerEntry.payoutId` |
| `src/platform/payouts/port.ts` (create) | `PayoutProvider` port, `unconfiguredPayouts` |
| `src/platform/payouts/payu.ts` (create) | PayU Payouts adapter |
| `src/platform/payouts/mock.ts` (create) | Dev provider |
| `src/platform/payouts/index.ts` (create) | Selects the provider from config |
| `src/modules/payments/service/payoutQuote.ts` (create) | R9, pure |
| `src/modules/payments/service/verification.ts` (create) | R3/R4 decision, pure |
| `src/modules/payments/repo/payouts.ts` (create) | Queries for both tables and the quote rows |
| `src/modules/payments/service/payouts.ts` (create) | R1–R16 service |
| `src/modules/payments/schema/payouts.ts` (create) | GraphQL, host + staff |
| `src/modules/payments/index.ts` (modify) | Wires `payouts` |
| `src/modules/events/index.ts` (modify) | Real publish gate (R5) |
| `src/modules/identity/index.ts` (modify) | Deletion guard (R16) |
| `src/modules/notifications/templates.ts` (modify) | Two templates |
| `src/platform/webhooks/payouts.ts` (create), `src/app.ts` (modify) | `POST /webhooks/payouts` |
| `src/worker.ts` (modify) | Jobs, schedules, outbox hooks |
| `src/platform/logging/index.ts` (modify) | Redaction |
| `tests/helpers/payouts.ts` (create), `tests/helpers/modules.ts` (modify) | `FakePayouts`, wiring |
| `tests/payouts.test.ts` (create) | Service tests |
| `scripts/payu-payouts-probe.ts` (create) | Sandbox probe |
| `docs/modules/07-payments.md`, `docs/modules/05-events.md` (modify) | Rules |

---

### Task 1: Payout config and the secret box

**Files:**
- Modify: `src/platform/config.ts` (schema object after `PUBLIC_API_URL`; refinements after the last `.refine`)
- Create: `src/platform/crypto/secretBox.ts`
- Test: `src/platform/config.test.ts`, `src/platform/crypto/secretBox.test.ts`

**Interfaces:**
- Produces: `config.PAYOUT_PROVIDER: 'none' | 'mock' | 'payu'`, `config.PAYU_PAYOUT_ENV`, `PAYU_PAYOUT_MERCHANT_ID`, `PAYU_PAYOUT_CLIENT_ID`, `PAYU_PAYOUT_CLIENT_SECRET`, `PAYOUT_DATA_KEY`, `PAYOUT_NAME_MATCH_AUTO: number`, `COMMISSION_GST_BPS?: number`, `HOST_TDS_BPS?: number`, `PAYOUT_IMPS_MAX_PAISE: bigint`, `PAYOUT_ALERT_EMAIL: string`.
- Produces: `createSecretBox(keyBase64: string): SecretBox` with `seal(plain: string): Buffer` and `open(sealed: Buffer): string`.

- [ ] **Step 1: Write the failing config tests**

Append to `src/platform/config.test.ts`:

```ts
const KEY = Buffer.alloc(32, 7).toString('base64');
const PAYOUTS = {
  PAYOUT_PROVIDER: 'payu',
  PAYU_PAYOUT_MERCHANT_ID: '1111594',
  PAYU_PAYOUT_CLIENT_ID: 'cid',
  PAYU_PAYOUT_CLIENT_SECRET: 'secret',
  PAYOUT_DATA_KEY: KEY,
  PUBLIC_API_URL: 'https://api.pl4y.app',
  PAYU_ENV: 'prod',
};

describe('config — payouts', () => {
  it('accepts PayU payouts in development without tax rates', () => {
    expect(issuesFor({ ...PAYOUTS, NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses PayU payouts in production until both tax rates are set', () => {
    expect(issuesFor({ ...PAYOUTS, NODE_ENV: 'production' })).toContain('HOST_TDS_BPS');
    expect(
      issuesFor({ ...PAYOUTS, NODE_ENV: 'production', COMMISSION_GST_BPS: '1800', HOST_TDS_BPS: '10' }),
    ).toEqual([]);
  });

  it('accepts a rate of zero as a deliberate answer', () => {
    expect(
      issuesFor({ ...PAYOUTS, NODE_ENV: 'production', COMMISSION_GST_BPS: '0', HOST_TDS_BPS: '0' }),
    ).toEqual([]);
  });

  it('needs the payout credentials for payu', () => {
    expect(issuesFor({ ...PAYOUTS, PAYU_PAYOUT_CLIENT_SECRET: '' })).toContain('PAYOUT_PROVIDER');
  });

  it('needs a 32-byte data key whenever payouts are on', () => {
    expect(issuesFor({ ...PAYOUTS, PAYOUT_DATA_KEY: 'c2hvcnQ=' })).toContain('PAYOUT_DATA_KEY');
    expect(issuesFor({ PAYOUT_PROVIDER: 'mock', PAYOUT_DATA_KEY: '' })).toContain('PAYOUT_DATA_KEY');
  });

  it('refuses the mock provider in production', () => {
    expect(
      issuesFor({ NODE_ENV: 'production', PAYOUT_PROVIDER: 'mock', PAYOUT_DATA_KEY: KEY, PAYU_ENV: 'prod', PUBLIC_API_URL: 'https://api.pl4y.app' }),
    ).toContain('PAYOUT_PROVIDER');
  });
});
```

- [ ] **Step 2: Write the failing secret box test**

Create `src/platform/crypto/secretBox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSecretBox } from './secretBox.js';

const key = Buffer.alloc(32, 1).toString('base64');

describe('secretBox', () => {
  it('round-trips', () => {
    const box = createSecretBox(key);
    expect(box.open(box.seal('ABCPS1234K'))).toBe('ABCPS1234K');
  });

  it('never produces the same bytes twice for the same input', () => {
    const box = createSecretBox(key);
    expect(box.seal('51234567890').equals(box.seal('51234567890'))).toBe(false);
  });

  it('refuses a tampered box', () => {
    const box = createSecretBox(key);
    const sealed = box.seal('51234567890');
    sealed[sealed.length - 1]! ^= 0xff;
    expect(() => box.open(sealed)).toThrow();
  });

  it('refuses the wrong key', () => {
    const sealed = createSecretBox(key).seal('x');
    expect(() => createSecretBox(Buffer.alloc(32, 2).toString('base64')).open(sealed)).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => createSecretBox('c2hvcnQ=')).toThrow('PAYOUT_DATA_KEY');
  });
});
```

- [ ] **Step 3: Run both to see them fail**

Run: `pnpm vitest run src/platform/config.test.ts src/platform/crypto/secretBox.test.ts`
Expected: FAIL — `secretBox.js` not found, and the payout config cases fail.

- [ ] **Step 4: Add the config keys**

In `src/platform/config.ts`, after `PUBLIC_API_URL: z.string().default(''),`:

```ts
  // payouts — hosts are paid through PayU Payouts (spec 2026-10-02-host-payouts).
  // `none` leaves paid publishing staff-only; `mock` is the dev provider.
  PAYOUT_PROVIDER: z.enum(['none', 'mock', 'payu']).default('none'),
  PAYU_PAYOUT_ENV: z.enum(['test', 'prod']).default('test'),
  // Not the PayU merchant key: Payouts has its own merchant id and OAuth client.
  PAYU_PAYOUT_MERCHANT_ID: z.string().default(''),
  PAYU_PAYOUT_CLIENT_ID: z.string().default(''),
  PAYU_PAYOUT_CLIENT_SECRET: z.string().default(''),
  // payouts R2 — 32 random bytes, base64. Encrypts PAN and account number.
  PAYOUT_DATA_KEY: z.string().default(''),
  // payouts R3 — PayU's nameMatch score at or above which a host verifies alone.
  PAYOUT_NAME_MATCH_AUTO: int(0, 100).default(80),
  // payouts R9 — a chartered accountant's answer, entered on purpose. No
  // production default: see the refinement below.
  COMMISSION_GST_BPS: int(0, 10_000).optional(),
  HOST_TDS_BPS: int(0, 10_000).optional(),
  PAYOUT_IMPS_MAX_PAISE: z.coerce.bigint().default(50_000_000n),
  // payouts R12 — where "top up the payouts account" goes.
  PAYOUT_ALERT_EMAIL: z.string().default(''),
```

After the last existing `.refine(...)` (before `;`), add:

```ts
).refine(
  (c) =>
    c.PAYOUT_PROVIDER !== 'payu' ||
    (c.PAYU_PAYOUT_MERCHANT_ID !== '' && c.PAYU_PAYOUT_CLIENT_ID !== '' && c.PAYU_PAYOUT_CLIENT_SECRET !== ''),
  { path: ['PAYOUT_PROVIDER'], message: 'payu payouts need PAYU_PAYOUT_MERCHANT_ID, _CLIENT_ID and _CLIENT_SECRET' },
).refine(
  (c) => c.PAYOUT_PROVIDER === 'none' || Buffer.from(c.PAYOUT_DATA_KEY, 'base64').length === 32,
  { path: ['PAYOUT_DATA_KEY'], message: 'must be 32 bytes, base64, when payouts are on' },
).refine(
  (c) => c.NODE_ENV !== 'production' || c.PAYOUT_PROVIDER !== 'mock',
  { path: ['PAYOUT_PROVIDER'], message: 'mock is for development only' },
).refine(
  // payouts R9 — tax on real money is never a default.
  (c) =>
    c.NODE_ENV !== 'production' ||
    c.PAYOUT_PROVIDER !== 'payu' ||
    (c.COMMISSION_GST_BPS !== undefined && c.HOST_TDS_BPS !== undefined),
  { path: ['HOST_TDS_BPS'], message: 'set COMMISSION_GST_BPS and HOST_TDS_BPS (a CA decides) before paying hosts' },
```

The last existing refinement ends with `);` — change it to `)` and close the chain after the new ones with `);`.

- [ ] **Step 5: Write the secret box**

Create `src/platform/crypto/secretBox.ts`:

```ts
/**
 * payouts R2 — PAN and bank account numbers at rest. AES-256-GCM, a fresh IV
 * per seal, and a one-byte version so the key can rotate without a migration:
 * a v2 key is added beside v1 and rows are re-sealed lazily.
 *
 * Layout: [version 1][iv 12][tag 16][ciphertext].
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  seal(plain: string): Buffer;
  open(sealed: Buffer): string;
}

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('PAYOUT_DATA_KEY must be 32 bytes, base64');

  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(sealed) {
      if (sealed[0] !== VERSION) throw new Error(`unknown secret box version ${sealed[0]}`);
      const iv = sealed.subarray(1, 1 + IV_BYTES);
      const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/platform/config.test.ts src/platform/crypto/secretBox.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platform/config.ts src/platform/config.test.ts src/platform/crypto
git commit -m "feat(payouts): config keys and the secret box (payouts R2, R9)"
```

---

### Task 2: PAN, IFSC and account-number checks

**Files:**
- Create: `src/modules/payments/service/pan.ts`
- Test: `src/modules/payments/service/pan.test.ts`

**Interfaces:**
- Produces:
  - `normaliseUpper(v: string): string` — trims, removes inner spaces, upper-cases.
  - `checkPan(pan: string): 'ok' | 'INVALID_PAN' | 'PAN_NOT_INDIVIDUAL'` (expects normalised input).
  - `panMatchesSurname(pan: string, legalName: string): boolean`.
  - `checkIfsc(ifsc: string): boolean`, `checkAccountNumber(n: string): boolean`.
  - `last4(v: string): string`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/payments/service/pan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkAccountNumber, checkIfsc, checkPan, last4, normaliseUpper, panMatchesSurname } from './pan.js';

describe('payouts R4 — PAN', () => {
  it.each([
    ['ABCPS1234K', 'ok'],
    ['ABCPS12345', 'INVALID_PAN'],
    ['ABCP1234K', 'INVALID_PAN'],
    ['ABCCS1234K', 'PAN_NOT_INDIVIDUAL'],
    ['ABCFS1234K', 'PAN_NOT_INDIVIDUAL'],
    ['ABCHS1234K', 'PAN_NOT_INDIVIDUAL'],
  ] as const)('%s → %s', (pan, expected) => {
    expect(checkPan(pan)).toBe(expected);
  });

  it('normalises lower case and spaces before checking', () => {
    expect(normaliseUpper('  abcps 1234k ')).toBe('ABCPS1234K');
    expect(checkPan(normaliseUpper('abcps1234k'))).toBe('ok');
  });

  it.each([
    ['ABCPS1234K', 'Rahul Sharma', true],
    ['ABCPK1234K', 'Rahul Sharma', false],
    ['ABCPK1234K', 'S. Ramesh Kumar', true],
    ['ABCPR1234K', 'Ramesh', true],
    ['ABCPS1234K', '  rahul   sharma  ', true],
    ['ABCPS1234K', '', false],
  ] as const)('%s with "%s" → surname match %s', (pan, name, expected) => {
    expect(panMatchesSurname(pan, name)).toBe(expected);
  });
});

describe('payouts R1 — bank details', () => {
  it('checks IFSC', () => {
    expect(checkIfsc('HDFC0001098')).toBe(true);
    expect(checkIfsc(normaliseUpper(' hdfc0001098 '))).toBe(true);
    expect(checkIfsc('HDFC1001098')).toBe(false);
    expect(checkIfsc('HDF0001098')).toBe(false);
  });

  it('checks the account number is 9–18 digits', () => {
    expect(checkAccountNumber('51234567890')).toBe(true);
    expect(checkAccountNumber('12345678')).toBe(false);
    expect(checkAccountNumber('1234567890123456789')).toBe(false);
    expect(checkAccountNumber('5123 4567 890')).toBe(false);
  });

  it('keeps the last four for masks', () => {
    expect(last4('51234567890')).toBe('7890');
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run src/modules/payments/service/pan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/modules/payments/service/pan.ts`:

```ts
/**
 * payouts R1, R4 — offline checks on what a host types. No API verifies a PAN
 * for us (PayU's PAN APIs are for its own merchant onboarding), so these are
 * structural: they catch typos and company PANs for free, before a penny test
 * is paid for. The surname check is a flag for staff, never a refusal.
 */

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;

export const normaliseUpper = (v: string): string => v.replace(/\s+/g, '').toUpperCase();

export function checkPan(pan: string): 'ok' | 'INVALID_PAN' | 'PAN_NOT_INDIVIDUAL' {
  if (!PAN_RE.test(pan)) return 'INVALID_PAN';
  // The 4th character is the holder type; P is an individual. Hosting payouts
  // go to people, and a company PAN changes the tax treatment entirely.
  if (pan[3] !== 'P') return 'PAN_NOT_INDIVIDUAL';
  return 'ok';
}

/**
 * For an individual the 5th character is the first letter of the surname.
 * "Surname" is the last word of the name as typed, which is wrong for
 * initial-first names ("S. Ramesh Kumar" may be filed under Kumar or under S),
 * so any word's initial counts — the check exists to catch someone else's PAN,
 * not to police name order.
 */
export function panMatchesSurname(pan: string, legalName: string): boolean {
  const words = legalName
    .trim()
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase());
  return words.includes(pan[4] ?? '');
}

export const checkIfsc = (ifsc: string): boolean => IFSC_RE.test(ifsc);

export const checkAccountNumber = (n: string): boolean => ACCOUNT_RE.test(n);

export const last4 = (v: string): string => v.slice(-4);
```

Note the spec's R4 table says "the first letter of the last word"; the `S. Ramesh Kumar` case shows why any word's initial must count. Update R4's sentence in the spec in this task's commit to "the first letter of any word of `legal_name`", keeping the rest of R4.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/modules/payments/service/pan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/payments/service/pan.ts src/modules/payments/service/pan.test.ts docs/superpowers/specs/2026-10-02-host-payouts-design.md
git commit -m "feat(payouts): offline PAN, IFSC and account checks (payouts R1, R4)"
```

---

### Task 3: Migration and Prisma models

**Files:**
- Create: `prisma/migrations/20261002100000_032_host_payouts/migration.sql`
- Modify: `prisma/schema.prisma` (after `model LedgerEntry`; add `payoutId` to `LedgerEntry`; add relations on `User` and `Event`)

**Interfaces:**
- Produces Prisma models `PayoutAccount` (`db.payoutAccount`) and `Payout` (`db.payout`) with the camelCase fields below, and `LedgerEntry.payoutId: string | null`.

- [ ] **Step 1: Write the migration**

Create `prisma/migrations/20261002100000_032_host_payouts/migration.sql`:

```sql
-- 032 — hosts are paid (spec 2026-10-02-host-payouts). One payout account per
-- user, verified by a penny test; one payout per event per account, settled
-- 72 h after the event ends through PayU Payouts.

CREATE TABLE "payout_accounts" (
    "id"                 UUID PRIMARY KEY,
    "user_id"            UUID NOT NULL UNIQUE REFERENCES "users"("id"),
    "legal_name"         TEXT NOT NULL,
    -- payouts R2 — sealed with PAYOUT_DATA_KEY; only the last four are clear.
    "pan_cipher"         BYTEA NOT NULL,
    "pan_last4"          TEXT NOT NULL,
    "account_cipher"     BYTEA NOT NULL,
    "account_last4"      TEXT NOT NULL,
    "ifsc"               TEXT NOT NULL,
    "pan_surname_ok"     BOOLEAN NOT NULL,
    "bank_name_returned" TEXT,
    "name_match"         SMALLINT,
    "status"             TEXT NOT NULL DEFAULT 'checking'
        CHECK ("status" IN ('checking', 'verified', 'needs_review', 'rejected', 'suspended')),
    "status_reason"      TEXT,
    "verify_ref"         TEXT,
    "check_attempts"     SMALLINT NOT NULL DEFAULT 0,
    "reviewed_by"        UUID REFERENCES "users"("id"),
    "reviewed_at"        TIMESTAMPTZ(6),
    "verified_at"        TIMESTAMPTZ(6),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The staff queue reads only the accounts waiting on a person.
CREATE INDEX "payout_accounts_review_idx" ON "payout_accounts" ("created_at")
    WHERE "status" = 'needs_review';

CREATE TABLE "payouts" (
    "id"                   UUID PRIMARY KEY,
    "payout_account_id"    UUID NOT NULL REFERENCES "payout_accounts"("id"),
    "event_id"             UUID NOT NULL REFERENCES "events"("id"),
    "entry_fees_paise"     BIGINT NOT NULL DEFAULT 0,
    "refunds_paise"        BIGINT NOT NULL DEFAULT 0,
    "commission_paise"     BIGINT NOT NULL DEFAULT 0,
    "commission_tax_paise" BIGINT NOT NULL DEFAULT 0,
    "tds_paise"            BIGINT NOT NULL DEFAULT 0,
    "receivables_paise"    BIGINT NOT NULL DEFAULT 0,
    "amount_paise"         BIGINT NOT NULL DEFAULT 0,
    "status"               TEXT NOT NULL DEFAULT 'scheduled'
        CHECK ("status" IN ('scheduled', 'held', 'awaiting_funds', 'sending', 'paid', 'failed')),
    -- 'staff:<reason>' for a staff hold (released only by staff), otherwise automatic.
    "hold_reason"          TEXT,
    -- The merchantRefId of the current attempt: the payout id, then <id>-r<n>.
    "transfer_ref"         TEXT UNIQUE,
    "provider_status"      TEXT,
    "provider_ref"         TEXT,
    "attempts"             SMALLINT NOT NULL DEFAULT 0,
    "last_error"           TEXT,
    "due_at"               TIMESTAMPTZ(6) NOT NULL,
    "sent_at"              TIMESTAMPTZ(6),
    "paid_at"              TIMESTAMPTZ(6),
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- payments R15 — a retried settle job can never create a second payout.
    UNIQUE ("event_id", "payout_account_id")
);

CREATE INDEX "payouts_due_idx" ON "payouts" ("due_at")
    WHERE "status" IN ('scheduled', 'held', 'awaiting_funds');
CREATE INDEX "payouts_sending_idx" ON "payouts" ("sent_at") WHERE "status" = 'sending';

ALTER TABLE "ledger_entries" ADD COLUMN "payout_id" UUID REFERENCES "payouts"("id");
CREATE INDEX "ledger_entries_payout_idx" ON "ledger_entries" ("payout_id");

-- payments R18 — every payout movement is a ledger row.
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind_check";
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_kind_check"
    CHECK ("kind" IN (
        'charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal',
        'host_commission', 'commission_tax', 'tds_withheld', 'host_payout',
        'host_receivable', 'receivable_recovered'
    ));
```

- [ ] **Step 2: Add the Prisma models**

In `prisma/schema.prisma`, add to `model LedgerEntry` (after `refundId`):

```prisma
  /// payouts R11 — set on the rows a payout writes.
  payoutId       String?  @map("payout_id") @db.Uuid
```

and in its relations block:

```prisma
  payout       Payout?       @relation(fields: [payoutId], references: [id])
```

After `model LedgerEntry { ... }`:

```prisma
/// payouts R1–R7 — where a host's money goes. One per user. The PAN and
/// account number are sealed (R2); nothing here is ever returned in clear.
model PayoutAccount {
  id               String    @id @db.Uuid
  userId           String    @unique @map("user_id") @db.Uuid
  legalName        String    @map("legal_name")
  panCipher        Bytes     @map("pan_cipher")
  panLast4         String    @map("pan_last4")
  accountCipher    Bytes     @map("account_cipher")
  accountLast4     String    @map("account_last4")
  ifsc             String
  panSurnameOk     Boolean   @map("pan_surname_ok")
  bankNameReturned String?   @map("bank_name_returned")
  nameMatch        Int?      @map("name_match") @db.SmallInt
  /// checking | verified | needs_review | rejected | suspended. CHECK in the migration.
  status           String    @default("checking")
  statusReason     String?   @map("status_reason")
  verifyRef        String?   @map("verify_ref")
  checkAttempts    Int       @default(0) @map("check_attempts") @db.SmallInt
  reviewedBy       String?   @map("reviewed_by") @db.Uuid
  reviewedAt       DateTime? @map("reviewed_at") @db.Timestamptz(6)
  verifiedAt       DateTime? @map("verified_at") @db.Timestamptz(6)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  user     User     @relation("payoutAccountUser", fields: [userId], references: [id])
  reviewer User?    @relation("payoutAccountReviewer", fields: [reviewedBy], references: [id])
  payouts  Payout[]

  @@map("payout_accounts")
}

/// payouts R8–R15 — one per event per account. The quote is frozen when the
/// transfer is sent, so the row always explains the amount that moved.
model Payout {
  id                 String    @id @db.Uuid
  payoutAccountId    String    @map("payout_account_id") @db.Uuid
  eventId            String    @map("event_id") @db.Uuid
  entryFeesPaise     BigInt    @default(0) @map("entry_fees_paise")
  refundsPaise       BigInt    @default(0) @map("refunds_paise")
  commissionPaise    BigInt    @default(0) @map("commission_paise")
  commissionTaxPaise BigInt    @default(0) @map("commission_tax_paise")
  tdsPaise           BigInt    @default(0) @map("tds_paise")
  receivablesPaise   BigInt    @default(0) @map("receivables_paise")
  amountPaise        BigInt    @default(0) @map("amount_paise")
  /// scheduled | held | awaiting_funds | sending | paid | failed. CHECK in the migration.
  status             String    @default("scheduled")
  holdReason         String?   @map("hold_reason")
  transferRef        String?   @unique @map("transfer_ref")
  providerStatus     String?   @map("provider_status")
  providerRef        String?   @map("provider_ref")
  attempts           Int       @default(0) @db.SmallInt
  lastError          String?   @map("last_error")
  dueAt              DateTime  @map("due_at") @db.Timestamptz(6)
  sentAt             DateTime? @map("sent_at") @db.Timestamptz(6)
  paidAt             DateTime? @map("paid_at") @db.Timestamptz(6)
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  payoutAccount PayoutAccount @relation(fields: [payoutAccountId], references: [id])
  event         Event         @relation(fields: [eventId], references: [id])
  ledgerEntries LedgerEntry[]

  @@unique([eventId, payoutAccountId])
  @@map("payouts")
}
```

In `model User` relations add:

```prisma
  payoutAccount         PayoutAccount?  @relation("payoutAccountUser")
  payoutAccountsReviewed PayoutAccount[] @relation("payoutAccountReviewer")
```

In `model Event` relations add:

```prisma
  payouts       Payout[]
```

- [ ] **Step 3: Apply and generate**

Run: `pnpm db:up && pnpm prisma migrate dev --skip-seed && pnpm db:generate && pnpm typecheck`
Expected: migration `032_host_payouts` applied; Prisma reports no drift; typecheck passes. If `migrate dev` reports drift for the hand-written partial indexes, that is expected for every partial index in this repo — confirm the same message appears on `main` before going on.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test`
Expected: PASS (no behaviour changed; the new CHECK still allows every old ledger kind).

- [ ] **Step 5: Commit**

```bash
git add prisma/migrations/20261002100000_032_host_payouts prisma/schema.prisma
git commit -m "feat(payouts): payout_accounts, payouts and ledger kinds (migration 032)"
```

---

### Task 4: The PayoutProvider port, PayU adapter and mock

**Files:**
- Create: `src/platform/payouts/port.ts`, `src/platform/payouts/payu.ts`, `src/platform/payouts/mock.ts`, `src/platform/payouts/index.ts`
- Test: `src/platform/payouts/payu.test.ts`

**Interfaces:**
- Consumes: `GatewayError` from `src/platform/gatewayError.ts` (`new GatewayError(status: number, message: string)`), `toPaise`/`toRupees` from `src/platform/payu/hash.ts`.
- Produces (`port.ts`):

```ts
export interface AccountCheck {
  outcome: 'exists' | 'missing' | 'pending';
  nameAtBank: string | null;
  /** PayU's 0–100 score, rounded. Null when PayU did not score. */
  nameMatch: number | null;
  error: string | null;
}
export type TransferState = 'pending' | 'success' | 'failed' | 'reversed' | 'unknown';
export interface TransferStatus { state: TransferState; providerStatus: string | null; providerRef: string | null; message: string | null }
export interface BankDetails { accountNumber: string; ifsc: string; name: string }
export interface PayoutProvider {
  readonly name: string;
  verifyAccount(input: BankDetails & { ref: string }): Promise<AccountCheck>;
  availablePaise(): Promise<bigint>;
  /** Accepted means PayU took it; the outcome comes from transferStatus. */
  transfer(input: BankDetails & { ref: string; amountPaise: bigint; mode: 'IMPS' | 'NEFT'; purpose: string }): Promise<{ accepted: boolean; error: string | null }>;
  transferStatus(ref: string): Promise<TransferStatus>;
  /** The merchantRefId a webhook is about, or null. Never trusted beyond that. */
  refFromWebhook(raw: Buffer): string | null;
}
export const unconfiguredPayouts: PayoutProvider;
export { GatewayError };
```

- Produces: `createPayUPayouts(opts: { env: 'test' | 'prod'; merchantId: string; clientId: string; clientSecret: string; fetch?: typeof fetch; now?: () => number }): PayoutProvider`; `createMockPayouts(): PayoutProvider`; `payoutProvider: PayoutProvider` and `payoutsConfigured(): boolean` from `index.ts`.

- [ ] **Step 1: Write the failing adapter test**

Create `src/platform/payouts/payu.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPayUPayouts } from './payu.js';
import { GatewayError } from './port.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.endsWith(k));
    const next = key ? responses[key]!.shift() : undefined;
    if (next === undefined) throw new Error(`no fake response for ${url}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const TOKEN = { access_token: 'tok', token_type: 'Bearer', expires_in: 6351, scope: 'create_payout_transactions' };
const bank = { accountNumber: '51234567890', ifsc: 'HDFC0001098', name: 'Rahul Sharma' };

const make = (responses: Record<string, unknown[]>, now = () => 0) => {
  const f = fakeFetch(responses);
  const provider = createPayUPayouts({ env: 'test', merchantId: '1111594', clientId: 'cid', clientSecret: 'sec', fetch: f.fn, now });
  return { provider, calls: f.calls };
};

describe('PayU payouts adapter', () => {
  it('verifies an account and reports the bank name and score', async () => {
    const { provider, calls } = make({
      '/oauth/token': [TOKEN],
      '/payment/verifyAccount': [
        { status: 0, data: { accountExists: 'YES', beneficiaryName: 'RAHUL SHARMA', nameMatch: 96.4, status: 'Success', error: '' } },
      ],
    });
    const check = await provider.verifyAccount({ ...bank, ref: 'v-1' });
    expect(check).toEqual({ outcome: 'exists', nameAtBank: 'RAHUL SHARMA', nameMatch: 96, error: null });
    const verify = calls[1]!;
    expect(verify.init.headers).toMatchObject({ authorization: 'Bearer tok', payoutMerchantId: '1111594' });
    expect(String(verify.init.body)).toContain('nameMatching=true');
    expect(String(verify.init.body)).toContain('beneName=Rahul+Sharma');
  });

  it('maps pending and missing accounts', async () => {
    const { provider } = make({
      '/oauth/token': [TOKEN],
      '/payment/verifyAccount': [
        { status: 0, data: { accountExists: 'VERIFICATION_PENDING', beneficiaryName: '', nameMatch: null, error: '' } },
        { status: 0, data: { accountExists: 'No', beneficiaryName: '', error: 'Invalid account' } },
      ],
    });
    expect((await provider.verifyAccount({ ...bank, ref: 'a' })).outcome).toBe('pending');
    expect(await provider.verifyAccount({ ...bank, ref: 'b' })).toMatchObject({ outcome: 'missing', error: 'Invalid account' });
  });

  it('reuses the token until a minute before it expires', async () => {
    let t = 0;
    const { provider, calls } = make(
      {
        '/oauth/token': [TOKEN, { ...TOKEN, access_token: 'tok2' }],
        '/merchant/getAccountDetail': [
          { status: 0, data: { balance: 940.5, transferableAmount: 900 } },
          { status: 0, data: { balance: 940.5, transferableAmount: 900 } },
          { status: 0, data: { balance: 940.5, transferableAmount: 900 } },
        ],
      },
      () => t,
    );
    await provider.availablePaise();
    t = 6_000_000;
    await provider.availablePaise();
    t = 6_300_000; // 6351 s − 51 s: inside the last minute
    await provider.availablePaise();
    expect(calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(2);
  });

  it('reads the available balance in paise', async () => {
    const { provider } = make({
      '/oauth/token': [TOKEN],
      '/merchant/getAccountDetail': [{ status: 0, data: { balance: 940.5, transferableAmount: 900 } }],
    });
    expect(await provider.availablePaise()).toBe(94_050n);
  });

  it('sends a transfer with our ref and rupee amount', async () => {
    const { provider, calls } = make({
      '/oauth/token': [TOKEN],
      '/payment': [{ status: 0, msg: 'Requests are in process', data: [] }],
    });
    const r = await provider.transfer({ ...bank, ref: 'p-1', amountPaise: 123_412n, mode: 'IMPS', purpose: 'PL4Y host payout' });
    expect(r).toEqual({ accepted: true, error: null });
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>[];
    expect(body[0]).toMatchObject({ merchantRefId: 'p-1', amount: 1234.12, paymentType: 'IMPS', beneficiaryAccountNumber: '51234567890' });
  });

  it('reports a refused transfer', async () => {
    const { provider } = make({
      '/oauth/token': [TOKEN],
      '/payment': [{ status: 1, data: [{ merchantRefId: 'p-1', error: 'beneficiary account number can not be empty. ', code: [1004] }] }],
    });
    expect(await provider.transfer({ ...bank, ref: 'p-1', amountPaise: 100n, mode: 'IMPS', purpose: 'x' })).toEqual({
      accepted: false,
      error: 'beneficiary account number can not be empty.',
    });
  });

  it.each([
    ['SUCCESS', 'success'],
    ['FAILED', 'failed'],
    ['FAILURE', 'failed'],
    ['REJECTED', 'failed'],
    ['CANCELLED', 'failed'],
    ['REVERSED', 'reversed'],
    ['QUEUED', 'pending'],
    ['IN_PROGRESS', 'pending'],
    ['WAITING_FOR_RETRY', 'pending'],
  ] as const)('maps txnStatus %s to %s', async (txnStatus, state) => {
    const { provider } = make({
      '/oauth/token': [TOKEN],
      '/payment/listTransactions': [
        { status: 0, data: { transactionDetails: [{ merchantRefId: 'p-1', txnStatus, payuTransactionRefNo: 'PAYOUT1', msg: 'm' }] } },
      ],
    });
    expect((await provider.transferStatus('p-1')).state).toBe(state);
  });

  it('treats an empty transaction list as unknown, never as failed', async () => {
    const { provider } = make({
      '/oauth/token': [TOKEN],
      '/payment/listTransactions': [{ status: 0, data: { transactionDetails: [] } }],
    });
    expect((await provider.transferStatus('p-1')).state).toBe('unknown');
  });

  it('turns a network failure into a GatewayError so the job retries', async () => {
    const { provider } = make({ '/oauth/token': [new TypeError('fetch failed')] });
    await expect(provider.availablePaise()).rejects.toBeInstanceOf(GatewayError);
  });

  it('reads the ref from a JSON or form webhook', () => {
    const { provider } = make({});
    expect(provider.refFromWebhook(Buffer.from(JSON.stringify({ merchantReferenceId: 'p-1', event: 'TRANSFER_SUCCESS' })))).toBe('p-1');
    expect(provider.refFromWebhook(Buffer.from('merchantRefId=p-2&event=TRANSFER_FAILED'))).toBe('p-2');
    expect(provider.refFromWebhook(Buffer.from('garbage'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run src/platform/payouts/payu.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the port**

Create `src/platform/payouts/port.ts`:

```ts
/**
 * Payout provider port (spec 2026-10-02-host-payouts). The ONLY place a payout
 * provider is spoken to and its secrets used, like paymentGateway.ts for
 * collection. Amounts are bigint paise; a provider's payloads never leave its
 * adapter.
 *
 * A webhook is a hint: `refFromWebhook` only says WHICH transfer to ask about.
 * PayU does not document a signature on payout webhooks, so the state always
 * comes from `transferStatus` (payouts R13).
 */
import { GatewayError } from '../gatewayError.js';

export { GatewayError };

export interface AccountCheck {
  outcome: 'exists' | 'missing' | 'pending';
  nameAtBank: string | null;
  /** PayU's 0–100 score, rounded. Null when PayU did not score. */
  nameMatch: number | null;
  error: string | null;
}

export type TransferState = 'pending' | 'success' | 'failed' | 'reversed' | 'unknown';

export interface TransferStatus {
  state: TransferState;
  providerStatus: string | null;
  providerRef: string | null;
  message: string | null;
}

export interface BankDetails {
  accountNumber: string;
  ifsc: string;
  name: string;
}

export interface PayoutProvider {
  readonly name: string;
  verifyAccount(input: BankDetails & { ref: string }): Promise<AccountCheck>;
  availablePaise(): Promise<bigint>;
  /** Accepted means PayU took it; the outcome comes from transferStatus. */
  transfer(
    input: BankDetails & { ref: string; amountPaise: bigint; mode: 'IMPS' | 'NEFT'; purpose: string },
  ): Promise<{ accepted: boolean; error: string | null }>;
  transferStatus(ref: string): Promise<TransferStatus>;
  /** The merchantRefId a webhook is about, or null. Never trusted beyond that. */
  refFromWebhook(raw: Buffer): string | null;
}

const notConfigured = (): never => {
  throw new GatewayError(503, 'No payout provider is configured');
};

/** What runs with PAYOUT_PROVIDER=none: nothing can verify or pay. */
export const unconfiguredPayouts: PayoutProvider = {
  name: 'none',
  verifyAccount: async () => notConfigured(),
  availablePaise: async () => notConfigured(),
  transfer: async () => notConfigured(),
  transferStatus: async () => notConfigured(),
  refFromWebhook: () => null,
};
```

- [ ] **Step 4: Write the PayU adapter**

Create `src/platform/payouts/payu.ts`:

```ts
/**
 * PayU Payouts behind the PayoutProvider port. `fetch`, no SDK. The ONLY file
 * that holds the payout client secret.
 *
 * Endpoints and payloads are from docs.payu.in (checked 2026-10-02) and are
 * confirmed against the sandbox by scripts/payu-payouts-probe.ts; where the
 * probe disagrees with this file, the probe wins and this file changes.
 */
import { GatewayError } from '../gatewayError.js';
import { toRupees } from '../payu/hash.js';
import type { AccountCheck, PayoutProvider, TransferState, TransferStatus } from './port.js';

const HOSTS = {
  test: { token: 'https://uat-accounts.payu.in/oauth/token', api: 'https://uatoneapi.payu.in/payout' },
  prod: { token: 'https://accounts.payu.in/oauth/token', api: 'https://payout.payumoney.com/payout' },
} as const;

/** A call gives up after 10 s so the job retries rather than hangs. */
const TIMEOUT_MS = 10_000;
/** Refresh a minute early: a token that expires mid-request is a failed payout. */
const TOKEN_SKEW_MS = 60_000;

const STATES: Record<string, TransferState> = {
  SUCCESS: 'success',
  FAILED: 'failed',
  FAILURE: 'failed',
  REJECTED: 'failed',
  CANCELLED: 'failed',
  REVERSED: 'reversed',
  QUEUED: 'pending',
  IN_PROGRESS: 'pending',
  'IN PROGRESS': 'pending',
  PENDING: 'pending',
  WAITING_FOR_RETRY: 'pending',
  'WAITING FOR RETRY': 'pending',
  PENDING_FOR_APPROVAL: 'pending',
  'PENDING FOR APPROVAL': 'pending',
};

interface Envelope<T> {
  status: number;
  msg?: string | null;
  data: T;
}

/** PayU's rupee number → paise, exactly: 940.5 → 94050n. */
const rupeesToPaise = (n: number): bigint => BigInt(Math.round(n * 100));

export function createPayUPayouts(opts: {
  env: 'test' | 'prod';
  merchantId: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}): PayoutProvider {
  const host = HOSTS[opts.env];
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let token: { value: string; expiresAt: number } | null = null;

  async function call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new GatewayError(503, `PayU payouts unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new GatewayError(res.status >= 500 ? 503 : res.status, `PayU payouts HTTP ${res.status}`);
    return res.json();
  }

  async function bearer(): Promise<string> {
    if (token && now() < token.expiresAt - TOKEN_SKEW_MS) return token.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      scope: 'create_payout_transactions',
    });
    const r = (await call(host.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })) as { access_token?: string; expires_in?: number };
    if (!r.access_token) throw new GatewayError(503, 'PayU payouts returned no token');
    token = { value: r.access_token, expiresAt: now() + (r.expires_in ?? 0) * 1000 };
    return token.value;
  }

  async function headers(contentType: string): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await bearer()}`,
      payoutMerchantId: opts.merchantId,
      'content-type': contentType,
    };
  }

  return {
    name: 'payu',

    async verifyAccount(input): Promise<AccountCheck> {
      const body = new URLSearchParams({
        accountNumber: input.accountNumber,
        ifscCode: input.ifsc,
        merchantRefId: input.ref,
        validateIfsc: 'true',
        beneName: input.name,
        nameMatching: 'true',
        purpose: 'Host verification',
      });
      const r = (await call(`${host.api}/payment/verifyAccount`, {
        method: 'POST',
        headers: await headers('application/x-www-form-urlencoded'),
        body,
      })) as Envelope<{ accountExists?: string; beneficiaryName?: string; nameMatch?: number | null; error?: string }>;
      const d = r.data ?? {};
      const exists = (d.accountExists ?? '').toUpperCase();
      const outcome = exists === 'YES' ? 'exists' : exists === 'VERIFICATION_PENDING' ? 'pending' : 'missing';
      return {
        outcome,
        nameAtBank: d.beneficiaryName ? d.beneficiaryName : null,
        nameMatch: typeof d.nameMatch === 'number' ? Math.round(d.nameMatch) : null,
        error: d.error ? d.error : null,
      };
    },

    async availablePaise() {
      const r = (await call(`${host.api}/merchant/getAccountDetail`, {
        method: 'GET',
        headers: await headers('application/x-www-form-urlencoded'),
      })) as Envelope<{ balance?: number }>;
      if (typeof r.data?.balance !== 'number') throw new GatewayError(503, 'PayU payouts returned no balance');
      return rupeesToPaise(r.data.balance);
    },

    async transfer(input) {
      const body = [
        {
          beneficiaryAccountNumber: input.accountNumber,
          beneficiaryIfscCode: input.ifsc,
          beneficiaryName: input.name,
          purpose: input.purpose,
          amount: Number(toRupees(input.amountPaise)),
          batchId: input.ref,
          merchantRefId: input.ref,
          paymentType: input.mode,
          retry: true,
        },
      ];
      const r = (await call(`${host.api}/payment`, {
        method: 'POST',
        headers: await headers('application/json'),
        body: JSON.stringify(body),
      })) as Envelope<{ error?: string }[]>;
      if (r.status === 0) return { accepted: true, error: null };
      const error = r.data?.[0]?.error?.trim() || r.msg || 'refused';
      return { accepted: false, error };
    },

    async transferStatus(ref): Promise<TransferStatus> {
      const body = new URLSearchParams({ merchantRefId: ref, page: '1', pageSize: '10' });
      const r = (await call(`${host.api}/payment/listTransactions`, {
        method: 'POST',
        headers: await headers('application/x-www-form-urlencoded'),
        body,
      })) as Envelope<{ transactionDetails?: { merchantRefId?: string; txnStatus?: string; payuTransactionRefNo?: string; msg?: string }[] }>;
      // PayU: status comes ONLY from txnStatus for our merchantRefId; an empty
      // list means "not determined", never "failed".
      const row = r.data?.transactionDetails?.find((t) => t.merchantRefId === ref);
      if (!row?.txnStatus) return { state: 'unknown', providerStatus: null, providerRef: null, message: null };
      return {
        state: STATES[row.txnStatus.toUpperCase()] ?? 'pending',
        providerStatus: row.txnStatus,
        providerRef: row.payuTransactionRefNo ?? null,
        message: row.msg ?? null,
      };
    },

    refFromWebhook(raw) {
      const text = raw.toString('utf8');
      let fields: Record<string, unknown> | null = null;
      try {
        fields = JSON.parse(text) as Record<string, unknown>;
      } catch {
        const params = new URLSearchParams(text);
        if ([...params.keys()].length > 1) fields = Object.fromEntries(params);
      }
      const ref = fields?.['merchantReferenceId'] ?? fields?.['merchantRefId'];
      return typeof ref === 'string' && ref.length > 0 && ref.length <= 40 ? ref : null;
    },
  };
}
```

- [ ] **Step 5: Write the mock provider and the selector**

Create `src/platform/payouts/mock.ts`:

```ts
/**
 * Dev-only payout provider (PAYOUT_PROVIDER=mock; refused in production by
 * config). Every account exists and matches 95; every transfer succeeds; the
 * balance is a crore. Enough to click through the app without PayU.
 */
import type { PayoutProvider } from './port.js';

export function createMockPayouts(): PayoutProvider {
  return {
    name: 'mock',
    verifyAccount: async (input) => ({ outcome: 'exists', nameAtBank: input.name.toUpperCase(), nameMatch: 95, error: null }),
    availablePaise: async () => 1_000_000_000n,
    transfer: async () => ({ accepted: true, error: null }),
    transferStatus: async (ref) => ({ state: 'success', providerStatus: 'SUCCESS', providerRef: `MOCK-${ref}`, message: null }),
    refFromWebhook: () => null,
  };
}
```

Create `src/platform/payouts/index.ts`:

```ts
/** Selects the payout provider from config (spec 2026-10-02-host-payouts). */
import { config } from '../config.js';
import { createMockPayouts } from './mock.js';
import { createPayUPayouts } from './payu.js';
import { unconfiguredPayouts, type PayoutProvider } from './port.js';

export * from './port.js';

export const payoutProvider: PayoutProvider =
  config.PAYOUT_PROVIDER === 'payu'
    ? createPayUPayouts({
        env: config.PAYU_PAYOUT_ENV,
        merchantId: config.PAYU_PAYOUT_MERCHANT_ID,
        clientId: config.PAYU_PAYOUT_CLIENT_ID,
        clientSecret: config.PAYU_PAYOUT_CLIENT_SECRET,
      })
    : config.PAYOUT_PROVIDER === 'mock'
      ? createMockPayouts()
      : unconfiguredPayouts;

export const payoutsConfigured = (): boolean => payoutProvider !== unconfiguredPayouts;
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/platform/payouts/payu.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/platform/payouts
git commit -m "feat(payouts): PayoutProvider port, PayU Payouts adapter and dev mock"
```

---

### Task 5: The quote and the verification decision (pure)

**Files:**
- Create: `src/modules/payments/service/payoutQuote.ts`, `src/modules/payments/service/verification.ts`
- Test: `src/modules/payments/service/payoutQuote.test.ts`, `src/modules/payments/service/verification.test.ts`

**Interfaces:**
- Consumes: `AccountCheck` from `src/platform/payouts/port.ts`.
- Produces:

```ts
// payoutQuote.ts
export interface QuoteRow { registrationId: string; kind: string; amountPaise: bigint; commissionBps: number }
export interface QuoteRates { commissionGstBps: number; tdsBps: number }
export interface PayoutQuote {
  entryFeesPaise: bigint; refundsPaise: bigint; commissionPaise: bigint;
  commissionTaxPaise: bigint; tdsPaise: bigint; receivablesPaise: bigint; amountPaise: bigint;
}
export function payoutQuote(rows: QuoteRow[], openReceivablesPaise: bigint, rates: QuoteRates): PayoutQuote
export const roundBps: (base: bigint, bps: number) => bigint
// verification.ts
export type VerifyDecision =
  | { status: 'verified' }
  | { status: 'needs_review'; reason: 'bank_name_mismatch' | 'pan_surname_mismatch' | 'bank_check_inconclusive' }
  | { status: 'rejected'; reason: string }
  | { status: 'retry' };
export function decideVerification(check: AccountCheck, panSurnameOk: boolean, autoThreshold: number): VerifyDecision
export function rejectionText(providerError: string | null): string
```

- [ ] **Step 1: Write the failing quote tests**

Create `src/modules/payments/service/payoutQuote.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { payoutQuote, roundBps, type QuoteRow } from './payoutQuote.js';

const ZERO = { commissionGstBps: 0, tdsBps: 0 };

/** One paid entry as payments R6 writes it: ₹500 fee + ₹50 platform fee + 18% tax. */
const paid = (id: string, bps = 1000): QuoteRow[] => [
  { registrationId: id, kind: 'charge', amountPaise: 64_900n, commissionBps: bps },
  { registrationId: id, kind: 'platform_fee', amountPaise: 5_000n, commissionBps: bps },
  { registrationId: id, kind: 'tax', amountPaise: 9_900n, commissionBps: bps },
];

const fullRefund = (id: string, bps = 1000): QuoteRow[] => [
  { registrationId: id, kind: 'refund', amountPaise: -64_900n, commissionBps: bps },
  { registrationId: id, kind: 'fee_reversal', amountPaise: -5_000n, commissionBps: bps },
  { registrationId: id, kind: 'tax_reversal', amountPaise: -9_900n, commissionBps: bps },
];

describe('payouts R9 — payoutQuote', () => {
  it('pays the entry fees less 10%', () => {
    const q = payoutQuote([...paid('a'), ...paid('b')], 0n, ZERO);
    expect(q).toEqual({
      entryFeesPaise: 100_000n,
      refundsPaise: 0n,
      commissionPaise: 10_000n,
      commissionTaxPaise: 0n,
      tdsPaise: 0n,
      receivablesPaise: 0n,
      amountPaise: 90_000n,
    });
  });

  it('a full refund nets the entry to nothing, commission included', () => {
    const q = payoutQuote([...paid('a'), ...fullRefund('a'), ...paid('b')], 0n, ZERO);
    expect(q.entryFeesPaise).toBe(100_000n);
    expect(q.refundsPaise).toBe(50_000n);
    expect(q.commissionPaise).toBe(5_000n);
    expect(q.amountPaise).toBe(45_000n);
  });

  it('a partial refund comes out of the entry fee only', () => {
    const q = payoutQuote(
      [...paid('a'), { registrationId: 'a', kind: 'refund', amountPaise: -20_000n, commissionBps: 1000 }],
      0n,
      ZERO,
    );
    expect(q.refundsPaise).toBe(20_000n);
    expect(q.commissionPaise).toBe(3_000n); // 10% of 30_000 left
    expect(q.amountPaise).toBe(27_000n);
  });

  it('never lets a refund push an entry below zero', () => {
    const q = payoutQuote(
      [...paid('a'), { registrationId: 'a', kind: 'refund', amountPaise: -60_000n, commissionBps: 1000 }],
      0n,
      ZERO,
    );
    expect(q.commissionPaise).toBe(0n);
    expect(q.amountPaise).toBe(0n);
  });

  it('uses each category frozen rate', () => {
    const q = payoutQuote([...paid('a', 1000), ...paid('b', 0)], 0n, ZERO);
    expect(q.commissionPaise).toBe(5_000n);
  });

  it('applies GST on the commission and TDS on the net fees', () => {
    const q = payoutQuote([...paid('a'), ...paid('b')], 0n, { commissionGstBps: 1800, tdsBps: 10 });
    expect(q.commissionTaxPaise).toBe(1_800n);
    expect(q.tdsPaise).toBe(100n);
    expect(q.amountPaise).toBe(100_000n - 10_000n - 1_800n - 100n);
  });

  it('nets open receivables, and may go negative for the caller to carry', () => {
    const q = payoutQuote(paid('a'), 60_000n, ZERO);
    expect(q.receivablesPaise).toBe(60_000n);
    expect(q.amountPaise).toBe(45_000n - 60_000n);
  });

  it('rounds half a paisa up', () => {
    expect(roundBps(5n, 1000)).toBe(1n); // 0.5 → 1
    expect(roundBps(4n, 1000)).toBe(0n); // 0.4 → 0
  });

  it('ignores rows that are not entry money', () => {
    const q = payoutQuote(
      [...paid('a'), { registrationId: 'a', kind: 'host_payout', amountPaise: -45_000n, commissionBps: 1000 }],
      0n,
      ZERO,
    );
    expect(q.amountPaise).toBe(45_000n);
  });
});
```

- [ ] **Step 2: Write the failing verification tests**

Create `src/modules/payments/service/verification.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideVerification, rejectionText } from './verification.js';

const exists = (nameMatch: number | null) => ({ outcome: 'exists' as const, nameAtBank: 'RAHUL SHARMA', nameMatch, error: null });

describe('payouts R3, R4 — decideVerification', () => {
  it('verifies a strong match with a matching surname', () => {
    expect(decideVerification(exists(96), true, 80)).toEqual({ status: 'verified' });
    expect(decideVerification(exists(80), true, 80)).toEqual({ status: 'verified' });
  });

  it('sends a weak bank match to review', () => {
    expect(decideVerification(exists(22), true, 80)).toEqual({ status: 'needs_review', reason: 'bank_name_mismatch' });
  });

  it('sends a surname mismatch to review even on a perfect bank match', () => {
    expect(decideVerification(exists(100), false, 80)).toEqual({ status: 'needs_review', reason: 'pan_surname_mismatch' });
  });

  it('sends an unscored match to review', () => {
    expect(decideVerification(exists(null), true, 80)).toEqual({ status: 'needs_review', reason: 'bank_check_inconclusive' });
  });

  it('retries a pending check', () => {
    expect(decideVerification({ outcome: 'pending', nameAtBank: null, nameMatch: null, error: null }, true, 80)).toEqual({
      status: 'retry',
    });
  });

  it('rejects a missing account with plain words', () => {
    expect(
      decideVerification({ outcome: 'missing', nameAtBank: null, nameMatch: null, error: 'Invalid account' }, true, 80),
    ).toEqual({ status: 'rejected', reason: rejectionText('Invalid account') });
  });

  it('says what to fix', () => {
    expect(rejectionText('Invalid IFSC code')).toMatch(/IFSC/);
    expect(rejectionText(null)).toMatch(/account number and IFSC/);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `pnpm vitest run src/modules/payments/service/payoutQuote.test.ts src/modules/payments/service/verification.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the quote**

Create `src/modules/payments/service/payoutQuote.ts`:

```ts
/**
 * payouts R9 — what a host is owed for one event. Pure over ledger rows, so
 * the number on the manage screen, the number transferred and the settlement
 * report can never disagree.
 *
 * Every row is signed (payments R6): refund, fee_reversal and tax_reversal are
 * already negative. A full refund reverses fee and tax too, so it nets the
 * entry fee to zero; a partial refund writes no reversal, so all of it comes
 * out of the entry fee — the host bears it, never the platform fee or the tax.
 */

export interface QuoteRow {
  registrationId: string;
  kind: string;
  amountPaise: bigint;
  /** The category's frozen commission_bps (migration 031). */
  commissionBps: number;
}

export interface QuoteRates {
  commissionGstBps: number;
  tdsBps: number;
}

export interface PayoutQuote {
  entryFeesPaise: bigint;
  refundsPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  tdsPaise: bigint;
  receivablesPaise: bigint;
  /** May be negative: the caller carries the shortfall as a receivable. */
  amountPaise: bigint;
}

/** Half-up in integers; every base here is non-negative. */
export const roundBps = (base: bigint, bps: number): bigint => (base * BigInt(bps) + 5_000n) / 10_000n;

interface Entry {
  fee: bigint;
  refunded: bigint;
  bps: number;
}

export function payoutQuote(rows: QuoteRow[], openReceivablesPaise: bigint, rates: QuoteRates): PayoutQuote {
  const entries = new Map<string, Entry>();
  for (const row of rows) {
    const e = entries.get(row.registrationId) ?? { fee: 0n, refunded: 0n, bps: row.commissionBps };
    switch (row.kind) {
      case 'charge':
        e.fee += row.amountPaise;
        break;
      case 'platform_fee':
      case 'tax':
        e.fee -= row.amountPaise;
        break;
      case 'refund':
        e.refunded -= row.amountPaise;
        break;
      case 'fee_reversal':
      case 'tax_reversal':
        e.refunded += row.amountPaise;
        break;
      default:
        continue;
    }
    entries.set(row.registrationId, e);
  }

  let entryFeesPaise = 0n;
  let refundsPaise = 0n;
  let commissionPaise = 0n;
  for (const e of entries.values()) {
    const refunded = e.refunded < e.fee ? e.refunded : e.fee;
    const net = e.fee - refunded;
    entryFeesPaise += e.fee;
    refundsPaise += refunded;
    commissionPaise += roundBps(net, e.bps);
  }

  const commissionTaxPaise = roundBps(commissionPaise, rates.commissionGstBps);
  const tdsPaise = roundBps(entryFeesPaise - refundsPaise, rates.tdsBps);
  const amountPaise =
    entryFeesPaise - refundsPaise - commissionPaise - commissionTaxPaise - tdsPaise - openReceivablesPaise;

  return {
    entryFeesPaise,
    refundsPaise,
    commissionPaise,
    commissionTaxPaise,
    tdsPaise,
    receivablesPaise: openReceivablesPaise,
    amountPaise,
  };
}
```

- [ ] **Step 5: Implement the decision**

Create `src/modules/payments/service/verification.ts`:

```ts
/**
 * payouts R3, R4 — what one penny-test answer means for an account. Pure, so
 * every row of the spec's tables is a unit test.
 */
import type { AccountCheck } from '../../../platform/payouts/port.js';

export type VerifyDecision =
  | { status: 'verified' }
  | { status: 'needs_review'; reason: 'bank_name_mismatch' | 'pan_surname_mismatch' | 'bank_check_inconclusive' }
  | { status: 'rejected'; reason: string }
  | { status: 'retry' };

export function decideVerification(check: AccountCheck, panSurnameOk: boolean, autoThreshold: number): VerifyDecision {
  if (check.outcome === 'pending') return { status: 'retry' };
  if (check.outcome === 'missing') return { status: 'rejected', reason: rejectionText(check.error) };
  // A surname flag stops auto-verification even on a perfect bank match: the
  // bank proves the account is the host's, not that the PAN is.
  if (!panSurnameOk) return { status: 'needs_review', reason: 'pan_surname_mismatch' };
  if (check.nameMatch === null) return { status: 'needs_review', reason: 'bank_check_inconclusive' };
  if (check.nameMatch < autoThreshold) return { status: 'needs_review', reason: 'bank_name_mismatch' };
  return { status: 'verified' };
}

/** What the host reads. PayU's own words are a hint, never shown raw. */
export function rejectionText(providerError: string | null): string {
  if (providerError && /ifsc/i.test(providerError)) {
    return "That IFSC code didn't match a bank branch. Check it and save again.";
  }
  return "We couldn't find this bank account. Check the account number and IFSC, then save again.";
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/modules/payments/service/payoutQuote.test.ts src/modules/payments/service/verification.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/payments/service/payoutQuote.ts src/modules/payments/service/payoutQuote.test.ts src/modules/payments/service/verification.ts src/modules/payments/service/verification.test.ts
git commit -m "feat(payouts): the payout quote and the verification decision (payouts R3, R4, R9)"
```

---

### Task 6: Payout accounts — save, verify, review, publish gate

**Files:**
- Create: `src/modules/payments/repo/payouts.ts`, `src/modules/payments/service/payouts.ts`, `tests/helpers/payouts.ts`, `tests/payouts.test.ts`
- Modify: `tests/helpers/modules.ts` (wire `payouts`), `src/modules/payments/index.ts`, `src/modules/events/index.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5.
- Produces (`service/payouts.ts`):

```ts
export const PayoutCode = {
  INVALID_PAN: 'INVALID_PAN', PAN_NOT_INDIVIDUAL: 'PAN_NOT_INDIVIDUAL', INVALID_IFSC: 'INVALID_IFSC',
  INVALID_ACCOUNT_NUMBER: 'INVALID_ACCOUNT_NUMBER', INVALID_NAME: 'INVALID_NAME',
  PAYOUT_DETAILS_RATE_LIMITED: 'PAYOUT_DETAILS_RATE_LIMITED',
  PAYOUT_ACCOUNT_REQUIRED: 'PAYOUT_ACCOUNT_REQUIRED', PAYOUT_ACCOUNT_NOT_VERIFIED: 'PAYOUT_ACCOUNT_NOT_VERIFIED',
  PAYOUT_NOT_HELD: 'PAYOUT_NOT_HELD', PAYOUT_NOT_FAILED: 'PAYOUT_NOT_FAILED',
} as const;
export type AccountStatus = 'checking' | 'verified' | 'needs_review' | 'rejected' | 'suspended';
export interface PayoutAccountView {
  id: string; userId: string; legalName: string; panMasked: string; accountMasked: string; ifsc: string;
  status: AccountStatus; statusReason: string | null; bankNameReturned: string | null; nameMatch: number | null;
  panSurnameOk: boolean; verifiedAt: Date | null; createdAt: Date;
}
export interface Staff { userId: string; role: 'admin' | 'finance' | 'support' }
export interface PayoutsDeps {
  db: Db; repo: PayoutsRepo; provider: PayoutProvider; box: SecretBox;
  limiter: { consume(key: string, window: { seconds: number; max: number }): Promise<{ allowed: boolean; retryAfterSeconds: number }> };
  jobs: { verifyAccount(accountId: string, delayMs: number): Promise<void>; checkPayout(payoutId: string, delayMs: number): Promise<void> };
  notify(userId: string, key: 'payout_account.status' | 'payout.status', payload: Record<string, string | null>): Promise<void>;
  alert(subject: string, text: string): Promise<void>;
  isStaff(userId: string): Promise<boolean>;
  config: { autoThreshold: number; commissionGstBps: number; tdsBps: number; impsMaxPaise: bigint };
  now?: () => Date;
}
export function createPayoutsService(deps: PayoutsDeps): PayoutsService
// PayoutsService members added in this task:
//   saveAccount(actor: { userId: string }, input: { legalName: string; pan: string; accountNumber: string; ifsc: string }): Promise<PayoutAccountView>
//   myAccount(userId: string): Promise<PayoutAccountView | null>
//   verifyAccount(accountId: string): Promise<void>                 // job
//   accountsForReview(staff: Staff): Promise<PayoutAccountView[]>
//   approveAccount(staff: Staff, id: string): Promise<PayoutAccountView>
//   rejectAccount(staff: Staff, id: string, reason: string): Promise<PayoutAccountView>
//   suspendAccount(staff: Staff, id: string, reason: string): Promise<PayoutAccountView>
//   reinstateAccount(staff: Staff, id: string): Promise<PayoutAccountView>
//   canPublishPaid(userId: string): Promise<{ ok: boolean; missing: string[] }>
export const VERIFY_RETRY_DELAYS_MS = [300_000, 1_800_000, 7_200_000];
export const DETAILS_WINDOW = { seconds: 86_400, max: 5 };
```

- [ ] **Step 1: Write the fake provider**

Create `tests/helpers/payouts.ts`:

```ts
/** A scripted PayoutProvider. Tests push answers; the network is never touched. */
import type { AccountCheck, PayoutProvider, TransferStatus } from '../../src/platform/payouts/port.js';
import { GatewayError } from '../../src/platform/payouts/port.js';

export class FakePayouts implements PayoutProvider {
  readonly name = 'fake';
  checks: AccountCheck[] = [];
  balance = 1_000_000_000n;
  transferAnswers: ({ accepted: boolean; error: string | null } | 'timeout')[] = [];
  statuses = new Map<string, TransferStatus>();
  verified: { ref: string; accountNumber: string; name: string }[] = [];
  transfers: { ref: string; amountPaise: bigint; accountNumber: string; mode: string }[] = [];

  async verifyAccount(input: { ref: string; accountNumber: string; ifsc: string; name: string }): Promise<AccountCheck> {
    this.verified.push({ ref: input.ref, accountNumber: input.accountNumber, name: input.name });
    const next = this.checks.shift();
    if (!next) throw new GatewayError(503, 'no scripted check');
    return next;
  }

  async availablePaise(): Promise<bigint> {
    return this.balance;
  }

  async transfer(input: { ref: string; amountPaise: bigint; accountNumber: string; mode: 'IMPS' | 'NEFT' }) {
    const answer = this.transferAnswers.shift() ?? { accepted: true, error: null };
    // A timeout AFTER PayU took the transfer: the money moves, we never hear.
    this.transfers.push({ ref: input.ref, amountPaise: input.amountPaise, accountNumber: input.accountNumber, mode: input.mode });
    if (answer === 'timeout') throw new GatewayError(503, 'timeout');
    return answer;
  }

  async transferStatus(ref: string): Promise<TransferStatus> {
    return this.statuses.get(ref) ?? { state: 'unknown', providerStatus: null, providerRef: null, message: null };
  }

  refFromWebhook(raw: Buffer): string | null {
    const ref = raw.toString('utf8');
    return ref.length > 0 ? ref : null;
  }

  succeed(ref: string): void {
    this.statuses.set(ref, { state: 'success', providerStatus: 'SUCCESS', providerRef: `PAYOUT-${ref}`, message: null });
  }

  fail(ref: string, state: 'failed' | 'reversed' = 'failed'): void {
    this.statuses.set(ref, { state, providerStatus: state.toUpperCase(), providerRef: null, message: 'bank said no' });
  }
}

export const exists = (nameMatch: number | null): AccountCheck => ({
  outcome: 'exists',
  nameAtBank: 'RAHUL SHARMA',
  nameMatch,
  error: null,
});
```

- [ ] **Step 2: Write the failing account tests**

Create `tests/payouts.test.ts` (Task 7 appends to it):

```ts
/**
 * payouts — service tests against a real Postgres (conventions.md §5), with a
 * scripted provider. Spec: docs/superpowers/specs/2026-10-02-host-payouts-design.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, type FakeQueue, type FakeGateway } from './helpers/modules.js';
import { FakePayouts, exists } from './helpers/payouts.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { PayoutsService, Staff } from '../src/modules/payments/service/payouts.js';
import { DETAILS_WINDOW, PayoutCode, VERIFY_RETRY_DELAYS_MS } from '../src/modules/payments/service/payouts.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let payouts: PayoutsService;
let payments: PaymentsService;
let registration: RegistrationService;
let events: EventService;
let profile: ProfileService;
let sport: SportService;
let provider: FakePayouts;
let gateway: FakeGateway;
let jobs: FakeQueue;
let notified: { userId: string; key: string; payload: Record<string, string | null> }[];
let alerts: string[];
let pickleballId: string;

const finance: Staff = { userId: '00000000-0000-7000-8000-000000000001', role: 'finance' };
const support: Staff = { userId: '00000000-0000-7000-8000-000000000002', role: 'support' };
const RAHUL = { legalName: 'Rahul Sharma', pan: 'ABCPS1234K', accountNumber: '51234567890', ifsc: 'HDFC0001098' };

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? 'THREW';
  }
  return 'NO_ERROR';
};

async function makeUser(name: string): Promise<{ userId: string; playerId: string }> {
  const userId = newId();
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: `${userId.slice(0, 8)}@example.com`, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  return { userId, playerId };
}

/** Staff are real platform_staff rows: the gate reads the table, never a shortcut. */
async function seedStaff(): Promise<void> {
  for (const s of [finance, support]) {
    await prisma.user.create({ data: { id: s.userId, email: `${s.role}@pl4y.test`, displayName: s.role } });
    await prisma.platformStaff.create({ data: { userId: s.userId, role: s.role } });
  }
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  payouts = wired.payouts;
  payments = wired.payments;
  registration = wired.registration;
  events = wired.events;
  profile = wired.profile;
  sport = wired.sport;
  provider = wired.payoutProvider;
  gateway = wired.gateway;
  jobs = wired.jobs;
  notified = wired.payoutNotices;
  alerts = wired.payoutAlerts;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  // reviewed_by is a foreign key, and the publish gate reads platform_staff.
  await seedStaff();
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  provider.checks = [];
  provider.transferAnswers = [];
  provider.statuses.clear();
  provider.verified = [];
  provider.transfers = [];
  provider.balance = 1_000_000_000n;
  jobs.reset();
  notified.length = 0;
  alerts.length = 0;
});

describe('payouts R1, R2 — saving bank details', () => {
  it('stores sealed details, masks them, and queues the bank check', async () => {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, { ...RAHUL, pan: ' abcps1234k ', ifsc: 'hdfc0001098' });
    expect(view).toMatchObject({ status: 'checking', panMasked: 'XXXXXX234K', accountMasked: 'XXXXXXX7890', ifsc: 'HDFC0001098', panSurnameOk: true });

    const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { userId: host.userId } });
    expect(row.panCipher.toString('utf8')).not.toContain('ABCPS1234K');
    expect(row.accountCipher.toString('utf8')).not.toContain('51234567890');
    expect(jobs.added.map((j) => j.name)).toContain('verify-payout-account');
  });

  it.each([
    [{ pan: 'ABCPS12345' }, PayoutCode.INVALID_PAN],
    [{ pan: 'ABCCS1234K' }, PayoutCode.PAN_NOT_INDIVIDUAL],
    [{ ifsc: 'HDFC1001098' }, PayoutCode.INVALID_IFSC],
    [{ accountNumber: '1234' }, PayoutCode.INVALID_ACCOUNT_NUMBER],
    [{ legalName: ' ' }, PayoutCode.INVALID_NAME],
  ])('refuses %o with %s and saves nothing', async (patch, code) => {
    const host = await makeUser('Rahul Sharma');
    expect(await errorCode(() => payouts.saveAccount(host, { ...RAHUL, ...patch }))).toBe(code);
    expect(await prisma.payoutAccount.count()).toBe(0);
    expect(jobs.added).toHaveLength(0);
  });

  it(`allows ${DETAILS_WINDOW.max} saves a day`, async () => {
    const host = await makeUser('Rahul Sharma');
    for (let i = 0; i < DETAILS_WINDOW.max; i++) await payouts.saveAccount(host, RAHUL);
    expect(await errorCode(() => payouts.saveAccount(host, RAHUL))).toBe(PayoutCode.PAYOUT_DETAILS_RATE_LIMITED);
  });

  it('replacing details restarts the check (R7)', async () => {
    const host = await makeUser('Rahul Sharma');
    const first = await payouts.saveAccount(host, RAHUL);
    provider.checks.push(exists(96));
    await payouts.verifyAccount(first.id);
    const again = await payouts.saveAccount(host, { ...RAHUL, accountNumber: '99887766554' });
    expect(again).toMatchObject({ id: first.id, status: 'checking', accountMasked: 'XXXXXXX6554', nameMatch: null });
  });
});

describe('payouts R3, R4 — the bank check', () => {
  async function saved(patch: Partial<typeof RAHUL> = {}) {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, { ...RAHUL, ...patch });
    return { host, id: view.id };
  }

  it('verifies a strong match and tells the host', async () => {
    const { host, id } = await saved();
    provider.checks.push(exists(96));
    await payouts.verifyAccount(id);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'verified', nameMatch: 96, bankNameReturned: 'RAHUL SHARMA' });
    expect(provider.verified[0]).toMatchObject({ accountNumber: '51234567890', name: 'Rahul Sharma' });
    expect(notified).toContainEqual({ userId: host.userId, key: 'payout_account.status', payload: { status: 'verified', reason: null } });
  });

  it('sends a surname mismatch to review on a perfect bank match', async () => {
    const { host, id } = await saved({ pan: 'ABCPK1234K' });
    provider.checks.push(exists(100));
    await payouts.verifyAccount(id);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'needs_review', statusReason: 'pan_surname_mismatch' });
  });

  it('rejects a missing account with words the host can act on', async () => {
    const { host, id } = await saved();
    provider.checks.push({ outcome: 'missing', nameAtBank: null, nameMatch: null, error: 'Invalid account' });
    await payouts.verifyAccount(id);
    const view = await payouts.myAccount(host.userId);
    expect(view?.status).toBe('rejected');
    expect(view?.statusReason).toMatch(/account number and IFSC/);
  });

  it('retries a pending check on 5 min, 30 min, 2 h, then asks a person', async () => {
    const { host, id } = await saved();
    for (const delay of VERIFY_RETRY_DELAYS_MS) {
      provider.checks.push({ outcome: 'pending', nameAtBank: null, nameMatch: null, error: null });
      jobs.reset();
      await payouts.verifyAccount(id);
      expect(jobs.added).toEqual([expect.objectContaining({ name: 'verify-payout-account', delayMs: delay })]);
    }
    provider.checks.push({ outcome: 'pending', nameAtBank: null, nameMatch: null, error: null });
    jobs.reset();
    await payouts.verifyAccount(id);
    expect(jobs.added).toHaveLength(0);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'needs_review', statusReason: 'bank_check_inconclusive' });
  });

  it('treats a provider outage like a pending answer', async () => {
    const { id } = await saved();
    jobs.reset();
    await payouts.verifyAccount(id); // FakePayouts throws: nothing scripted
    expect(jobs.added).toEqual([expect.objectContaining({ name: 'verify-payout-account', delayMs: VERIFY_RETRY_DELAYS_MS[0] })]);
  });

  it('ignores a stale job for an account no longer checking', async () => {
    const { id } = await saved();
    provider.checks.push(exists(96));
    await payouts.verifyAccount(id);
    await payouts.verifyAccount(id);
    expect(provider.verified).toHaveLength(1);
  });
});

describe('payouts R6 — staff review', () => {
  async function inReview() {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, { ...RAHUL, pan: 'ABCPK1234K' });
    provider.checks.push(exists(100));
    await payouts.verifyAccount(view.id);
    return { host, id: view.id };
  }

  it('lists the queue for support but lets only admin and finance decide', async () => {
    const { id } = await inReview();
    expect((await payouts.accountsForReview(support)).map((a) => a.id)).toEqual([id]);
    expect(await errorCode(() => payouts.approveAccount(support, id))).toBe('FORBIDDEN');
  });

  it('approves, recording who and when', async () => {
    const { host, id } = await inReview();
    expect(await payouts.approveAccount(finance, id)).toMatchObject({ status: 'verified' });
    const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id } });
    expect(row.reviewedBy).toBe(finance.userId);
    expect(notified.at(-1)).toEqual({ userId: host.userId, key: 'payout_account.status', payload: { status: 'verified', reason: null } });
  });

  it('rejects and suspends with a reason, and reinstates', async () => {
    const { id } = await inReview();
    expect(await payouts.rejectAccount(finance, id, 'PAN belongs to someone else')).toMatchObject({ status: 'rejected', statusReason: 'PAN belongs to someone else' });
    await payouts.approveAccount(finance, id);
    expect(await payouts.suspendAccount(finance, id, 'chargebacks')).toMatchObject({ status: 'suspended' });
    expect(await payouts.reinstateAccount(finance, id)).toMatchObject({ status: 'verified' });
  });
});

describe('payouts R5 — the paid publish gate', () => {
  it('says what is missing until the account is verified', async () => {
    const host = await makeUser('Rahul Sharma');
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['no account'] });
    const view = await payouts.saveAccount(host, RAHUL);
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['checking'] });
    provider.checks.push(exists(96));
    await payouts.verifyAccount(view.id);
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: true, missing: [] });
  });

  it('lets platform staff publish without an account', async () => {
    expect(await payouts.canPublishPaid(finance.userId)).toEqual({ ok: true, missing: [] });
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `pnpm vitest run tests/payouts.test.ts`
Expected: FAIL — `service/payouts.js` not found and `buildModules` has no `payouts`.

- [ ] **Step 4: Write the repo**

Create `src/modules/payments/repo/payouts.ts`:

```ts
/**
 * payouts — queries. The service owns the rules; this owns the SQL shapes,
 * including the one join the quote needs (ledger → registration → category).
 */
import type { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import type { QuoteRow } from '../service/payoutQuote.js';

export type PayoutAccountRow = Prisma.PayoutAccountGetPayload<object>;
export type PayoutRow = Prisma.PayoutGetPayload<object>;
type Conn = Db | Tx;

export function createPayoutsRepo(db: Db) {
  return {
    accountByUser: (userId: string, conn: Conn = db) => conn.payoutAccount.findUnique({ where: { userId } }),
    accountById: (id: string, conn: Conn = db) => conn.payoutAccount.findUnique({ where: { id } }),
    accountsInReview: () =>
      db.payoutAccount.findMany({ where: { status: 'needs_review' }, orderBy: { createdAt: 'asc' }, take: 200 }),

    payoutById: (id: string, conn: Conn = db) => conn.payout.findUnique({ where: { id } }),
    payoutByRef: (transferRef: string) => db.payout.findUnique({ where: { transferRef } }),
    payoutForEvent: (eventId: string) => db.payout.findFirst({ where: { eventId } }),
    payoutsForAccount: (payoutAccountId: string, take: number, cursor: string | null) =>
      db.payout.findMany({
        where: { payoutAccountId },
        orderBy: [{ dueAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    duePayouts: (now: Date) =>
      db.payout.findMany({
        where: { status: { in: ['scheduled', 'held', 'awaiting_funds'] }, dueAt: { lte: now } },
        orderBy: { dueAt: 'asc' },
        take: 100,
      }),
    staleSending: (before: Date) =>
      db.payout.findMany({ where: { status: 'sending', sentAt: { lte: before } }, take: 100 }),
    heldOrFailed: () =>
      db.payout.findMany({ where: { status: { in: ['held', 'failed', 'awaiting_funds'] } }, orderBy: { dueAt: 'asc' }, take: 200 }),

    /** payouts R9 — every entry-money row for the event, with its category's frozen rate. */
    async quoteRows(eventId: string, conn: Conn = db): Promise<QuoteRow[]> {
      const rows = await conn.$queryRaw<{ registration_id: string; kind: string; amount_paise: bigint; commission_bps: number }[]>`
        SELECT le.registration_id, le.kind, le.amount_paise, ec.commission_bps
          FROM ledger_entries le
          JOIN registrations r ON r.id = le.registration_id
          JOIN event_categories ec ON ec.id = r.event_category_id
         WHERE r.event_id = ${eventId}::uuid
           AND le.kind IN ('charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal')`;
      return rows.map((r) => ({
        registrationId: r.registration_id,
        kind: r.kind,
        amountPaise: r.amount_paise,
        commissionBps: r.commission_bps,
      }));
    },

    /** payouts R15 — receivables written minus receivables recovered, for one account. */
    async openReceivables(payoutAccountId: string, conn: Conn = db): Promise<bigint> {
      const [row] = await conn.$queryRaw<{ open: bigint | null }[]>`
        SELECT SUM(le.amount_paise) AS open
          FROM ledger_entries le
          JOIN payouts p ON p.id = le.payout_id
         WHERE p.payout_account_id = ${payoutAccountId}::uuid
           AND le.kind IN ('host_receivable', 'receivable_recovered')`;
      return row?.open ?? 0n;
    },

    /** Refunds for this event that payments has decided but the gateway has not settled. */
    async pendingRefundCount(eventId: string, conn: Conn = db): Promise<number> {
      const [row] = await conn.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
          FROM refunds rf
          JOIN payments pm ON pm.id = rf.payment_id
          JOIN payment_orders po ON po.id = pm.payment_order_id
          JOIN registrations r ON r.id = po.registration_id
         WHERE r.event_id = ${eventId}::uuid AND rf.status = 'pending'`;
      return Number(row?.n ?? 0n);
    },

    /** The ledger rows a refund wrote: refund, and on a full refund its reversals. */
    refundLedger: (refundId: string) => db.ledgerEntry.findMany({ where: { refundId } }),

    /** Locks one payout for a state change (payments R15: one transfer, ever). */
    async lockPayout(tx: Tx, id: string): Promise<PayoutRow | null> {
      await tx.$queryRaw`SELECT id FROM payouts WHERE id = ${id}::uuid FOR UPDATE`;
      return tx.payout.findUnique({ where: { id } });
    },
  };
}

export type PayoutsRepo = ReturnType<typeof createPayoutsRepo>;
```

Before relying on `pendingRefundCount`, confirm the column names with `grep -n "model Payment \|model PaymentOrder" -A12 prisma/schema.prisma`: `payments.payment_order_id` and `payment_orders.registration_id` are the joins used. If either differs, fix the SQL in this step.

- [ ] **Step 5: Write the account half of the service**

Create `src/modules/payments/service/payouts.ts`:

```ts
/**
 * payouts — host verification and payouts (spec 2026-10-02-host-payouts).
 *
 * A second service beside payments' own: it shares the ledger and the module
 * boundary, not the collection state machine. The provider is a port
 * (platform/payouts); nothing here knows PayU's shapes.
 *
 * Money only moves to an account a penny test (or a person) has verified, and
 * a payout id is the transfer's merchantRefId, so a retried job can never pay
 * twice (payments R15).
 */
import type { Db } from '../../../platform/db.js';
import type { SecretBox } from '../../../platform/crypto/secretBox.js';
import { SystemError, UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import type { PayoutProvider } from '../../../platform/payouts/port.js';
import type { PayoutAccountRow, PayoutsRepo } from '../repo/payouts.js';
import { checkAccountNumber, checkIfsc, checkPan, last4, normaliseUpper, panMatchesSurname } from './pan.js';
import { decideVerification } from './verification.js';

export const PayoutCode = {
  INVALID_PAN: 'INVALID_PAN',
  PAN_NOT_INDIVIDUAL: 'PAN_NOT_INDIVIDUAL',
  INVALID_IFSC: 'INVALID_IFSC',
  INVALID_ACCOUNT_NUMBER: 'INVALID_ACCOUNT_NUMBER',
  INVALID_NAME: 'INVALID_NAME',
  PAYOUT_DETAILS_RATE_LIMITED: 'PAYOUT_DETAILS_RATE_LIMITED',
  PAYOUT_ACCOUNT_REQUIRED: 'PAYOUT_ACCOUNT_REQUIRED',
  PAYOUT_ACCOUNT_NOT_VERIFIED: 'PAYOUT_ACCOUNT_NOT_VERIFIED',
  PAYOUT_NOT_HELD: 'PAYOUT_NOT_HELD',
  PAYOUT_NOT_FAILED: 'PAYOUT_NOT_FAILED',
} as const;

/** payouts R3 — 5 min, 30 min, 2 h; then a person looks. */
export const VERIFY_RETRY_DELAYS_MS = [300_000, 1_800_000, 7_200_000];
/** payouts R1 — every save is a paid penny test. */
export const DETAILS_WINDOW = { seconds: 86_400, max: 5 };

export type AccountStatus = 'checking' | 'verified' | 'needs_review' | 'rejected' | 'suspended';

export interface PayoutAccountView {
  id: string;
  userId: string;
  legalName: string;
  panMasked: string;
  accountMasked: string;
  ifsc: string;
  status: AccountStatus;
  statusReason: string | null;
  bankNameReturned: string | null;
  nameMatch: number | null;
  panSurnameOk: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface Staff {
  userId: string;
  role: 'admin' | 'finance' | 'support';
}

export interface PayoutsDeps {
  db: Db;
  repo: PayoutsRepo;
  provider: PayoutProvider;
  box: SecretBox;
  limiter: {
    consume(key: string, window: { seconds: number; max: number }): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  };
  jobs: {
    verifyAccount(accountId: string, delayMs: number): Promise<void>;
    checkPayout(payoutId: string, delayMs: number): Promise<void>;
  };
  notify(userId: string, key: 'payout_account.status' | 'payout.status', payload: Record<string, string | null>): Promise<void>;
  /** payouts R12 — finance's inbox. Rate limiting is the caller's job. */
  alert(subject: string, text: string): Promise<void>;
  isStaff(userId: string): Promise<boolean>;
  config: { autoThreshold: number; commissionGstBps: number; tdsBps: number; impsMaxPaise: bigint };
  now?: () => Date;
}

const mask = (clear4: string, total: number): string => 'X'.repeat(total - 4) + clear4;

function toView(row: PayoutAccountRow): PayoutAccountView {
  return {
    id: row.id,
    userId: row.userId,
    legalName: row.legalName,
    panMasked: mask(row.panLast4, 10),
    accountMasked: mask(row.accountLast4, 11),
    ifsc: row.ifsc,
    status: row.status as AccountStatus,
    statusReason: row.statusReason,
    bankNameReturned: row.bankNameReturned,
    nameMatch: row.nameMatch,
    panSurnameOk: row.panSurnameOk,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}

const DECIDERS: Staff['role'][] = ['admin', 'finance'];

function requireDecider(staff: Staff): void {
  if (!DECIDERS.includes(staff.role)) throw forbidden();
}

export function createPayoutsService(deps: PayoutsDeps) {
  const { db, repo, provider, box } = deps;
  const now = deps.now ?? (() => new Date());

  async function accountOrThrow(id: string): Promise<PayoutAccountRow> {
    const row = await repo.accountById(id);
    if (!row) throw new SystemError('NOT_FOUND', 'No such payout account');
    return row;
  }

  async function setStatus(
    id: string,
    status: AccountStatus,
    reason: string | null,
    extra: { reviewedBy?: string } = {},
  ): Promise<PayoutAccountView> {
    const row = await db.payoutAccount.update({
      where: { id },
      data: {
        status,
        statusReason: reason,
        verifiedAt: status === 'verified' ? now() : undefined,
        ...(extra.reviewedBy ? { reviewedBy: extra.reviewedBy, reviewedAt: now() } : {}),
      },
    });
    await deps.notify(row.userId, 'payout_account.status', { status, reason });
    return toView(row);
  }

  // --- R1, R2, R7 — saving --------------------------------------------------

  async function saveAccount(
    actor: { userId: string },
    input: { legalName: string; pan: string; accountNumber: string; ifsc: string },
  ): Promise<PayoutAccountView> {
    const legalName = input.legalName.trim().replace(/\s+/g, ' ');
    const pan = normaliseUpper(input.pan);
    const ifsc = normaliseUpper(input.ifsc);
    const accountNumber = input.accountNumber.trim();

    if (legalName.length < 2) throw new UserError(PayoutCode.INVALID_NAME, 'Enter your name as it is on your bank account.');
    const panCheck = checkPan(pan);
    if (panCheck === 'INVALID_PAN') throw new UserError(PayoutCode.INVALID_PAN, "That PAN doesn't look right. It's 5 letters, 4 digits, then a letter.");
    if (panCheck === 'PAN_NOT_INDIVIDUAL') throw new UserError(PayoutCode.PAN_NOT_INDIVIDUAL, 'Use your personal PAN. Hosting payouts go to individuals.');
    if (!checkIfsc(ifsc)) throw new UserError(PayoutCode.INVALID_IFSC, "That IFSC doesn't look right. It's 11 characters, like HDFC0001234.");
    if (!checkAccountNumber(accountNumber)) throw new UserError(PayoutCode.INVALID_ACCOUNT_NUMBER, 'Account numbers are 9 to 18 digits.');

    const limit = await deps.limiter.consume(`payout-details:${actor.userId}`, DETAILS_WINDOW);
    if (!limit.allowed) {
      throw new UserError(PayoutCode.PAYOUT_DETAILS_RATE_LIMITED, 'Too many changes today. Try again tomorrow.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const fields = {
      legalName,
      panCipher: box.seal(pan),
      panLast4: last4(pan),
      accountCipher: box.seal(accountNumber),
      accountLast4: last4(accountNumber),
      ifsc,
      panSurnameOk: panMatchesSurname(pan, legalName),
      status: 'checking',
      statusReason: null,
      bankNameReturned: null,
      nameMatch: null,
      verifyRef: null,
      checkAttempts: 0,
      reviewedBy: null,
      reviewedAt: null,
      verifiedAt: null,
    };
    const row = await db.payoutAccount.upsert({
      where: { userId: actor.userId },
      create: { id: newId(), userId: actor.userId, ...fields },
      update: fields,
    });
    await deps.jobs.verifyAccount(row.id, 0);
    return toView(row);
  }

  async function myAccount(userId: string): Promise<PayoutAccountView | null> {
    const row = await repo.accountByUser(userId);
    return row ? toView(row) : null;
  }

  // --- R3, R4 — the bank check (a job) -------------------------------------

  async function retryOrReview(row: PayoutAccountRow): Promise<void> {
    const attempt = row.checkAttempts;
    if (attempt < VERIFY_RETRY_DELAYS_MS.length) {
      await db.payoutAccount.update({ where: { id: row.id }, data: { checkAttempts: attempt + 1 } });
      await deps.jobs.verifyAccount(row.id, VERIFY_RETRY_DELAYS_MS[attempt]!);
      return;
    }
    await setStatus(row.id, 'needs_review', 'bank_check_inconclusive');
  }

  async function verifyAccount(accountId: string): Promise<void> {
    const row = await repo.accountById(accountId);
    // A stale job: the host saved again (new job queued) or a person decided.
    if (!row || row.status !== 'checking') return;

    const ref = `v-${row.id.slice(0, 8)}-${row.checkAttempts}-${Date.now().toString(36)}`;
    await db.payoutAccount.update({ where: { id: row.id }, data: { verifyRef: ref } });

    let check;
    try {
      check = await provider.verifyAccount({
        ref,
        accountNumber: box.open(row.accountCipher),
        ifsc: row.ifsc,
        name: row.legalName,
      });
    } catch (err) {
      logger.warn({ err, accountId }, 'payout account check failed; will retry');
      await retryOrReview(row);
      return;
    }

    await db.payoutAccount.update({
      where: { id: row.id },
      data: { bankNameReturned: check.nameAtBank, nameMatch: check.nameMatch },
    });
    const decision = decideVerification(check, row.panSurnameOk, deps.config.autoThreshold);
    if (decision.status === 'retry') {
      await retryOrReview(row);
      return;
    }
    await setStatus(row.id, decision.status, decision.status === 'verified' ? null : decision.reason);
  }

  // --- R6 — staff ------------------------------------------------------------

  async function accountsForReview(_staff: Staff): Promise<PayoutAccountView[]> {
    return (await repo.accountsInReview()).map(toView);
  }

  async function approveAccount(staff: Staff, id: string): Promise<PayoutAccountView> {
    requireDecider(staff);
    await accountOrThrow(id);
    return setStatus(id, 'verified', null, { reviewedBy: staff.userId });
  }

  async function rejectAccount(staff: Staff, id: string, reason: string): Promise<PayoutAccountView> {
    requireDecider(staff);
    await accountOrThrow(id);
    return setStatus(id, 'rejected', reason.trim(), { reviewedBy: staff.userId });
  }

  async function suspendAccount(staff: Staff, id: string, reason: string): Promise<PayoutAccountView> {
    requireDecider(staff);
    await accountOrThrow(id);
    return setStatus(id, 'suspended', reason.trim(), { reviewedBy: staff.userId });
  }

  async function reinstateAccount(staff: Staff, id: string): Promise<PayoutAccountView> {
    requireDecider(staff);
    const row = await accountOrThrow(id);
    if (row.status !== 'suspended') throw new SystemError('ILLEGAL_TRANSITION', `Illegal transition ${row.status} -> verified`);
    return setStatus(id, 'verified', null, { reviewedBy: staff.userId });
  }

  // --- R5 — the publish gate -------------------------------------------------

  async function canPublishPaid(userId: string): Promise<{ ok: boolean; missing: string[] }> {
    if (await deps.isStaff(userId)) return { ok: true, missing: [] };
    const row = await repo.accountByUser(userId);
    if (!row) return { ok: false, missing: ['no account'] };
    if (row.status === 'verified') return { ok: true, missing: [] };
    return { ok: false, missing: [row.status.replace('_', ' ')] };
  }

  return {
    saveAccount,
    myAccount,
    verifyAccount,
    accountsForReview,
    approveAccount,
    rejectAccount,
    suspendAccount,
    reinstateAccount,
    canPublishPaid,
  };
}

export type PayoutsService = ReturnType<typeof createPayoutsService>;
```

- [ ] **Step 6: Wire the test modules**

In `tests/helpers/modules.ts`:

1. Add imports:

```ts
import { createPayoutsRepo } from '../../src/modules/payments/repo/payouts.js';
import { createPayoutsService } from '../../src/modules/payments/service/payouts.js';
import { createSecretBox } from '../../src/platform/crypto/secretBox.js';
import { createRateLimiter } from '../../src/platform/rateLimit.js';
import { FakePayouts } from './payouts.js';
```

2. Find `class FakeQueue` (`grep -n "class FakeQueue" -A30 tests/helpers/modules.ts`). Give it a generic recorder, keeping every existing method:

```ts
  /** Generic jobs recorded by the payouts port. */
  added: { name: string; id: string; delayMs: number }[] = [];
  async verifyAccount(accountId: string, delayMs: number): Promise<void> {
    this.added.push({ name: 'verify-payout-account', id: accountId, delayMs });
  }
  async checkPayout(payoutId: string, delayMs: number): Promise<void> {
    this.added.push({ name: 'check-payout', id: payoutId, delayMs });
  }
```

and in its existing `reset()` (add one if absent) clear `this.added = [];`.

3. In `buildModules`, after `paymentsService` is created:

```ts
  const payoutProvider = new FakePayouts();
  const payoutNotices: { userId: string; key: string; payload: Record<string, string | null> }[] = [];
  const payoutAlerts: string[] = [];
  const payoutsService = createPayoutsService({
    db,
    repo: createPayoutsRepo(db),
    provider: payoutProvider,
    box: createSecretBox(Buffer.alloc(32, 9).toString('base64')),
    limiter: createRateLimiter(db),
    jobs,
    notify: async (userId, key, payload) => {
      payoutNotices.push({ userId, key, payload });
    },
    alert: async (subject) => {
      payoutAlerts.push(subject);
    },
    isStaff: async (userId) => (await prisma.platformStaff.findUnique({ where: { userId } })) !== null,
    config: { autoThreshold: 80, commissionGstBps: 0, tdsBps: 0, impsMaxPaise: 50_000_000n },
  });
```

4. Add `payouts: payoutsService, payoutProvider, payoutNotices, payoutAlerts,` to the object `buildModules` returns.

- [ ] **Step 7: Wire production**

In `src/modules/payments/index.ts`, add imports:

```ts
import { config } from '../../platform/config.js';
import { createSecretBox, type SecretBox } from '../../platform/crypto/secretBox.js';
import { consume } from '../../platform/rateLimit.js';
import { payoutProvider } from '../../platform/payouts/index.js';
import { createPayoutsRepo } from './repo/payouts.js';
import { createPayoutsService } from './service/payouts.js';
```

and after `export const payments = ...;`:

```ts
/** payouts R2 — no key, no payouts: a box that refuses beats a silent clear-text fallback. */
const box: SecretBox =
  config.PAYOUT_DATA_KEY !== ''
    ? createSecretBox(config.PAYOUT_DATA_KEY)
    : {
        seal: () => {
          throw new SystemError('PAYOUTS_UNAVAILABLE', 'Payouts are not configured');
        },
        open: () => {
          throw new SystemError('PAYOUTS_UNAVAILABLE', 'Payouts are not configured');
        },
      };

let lastAlertAt = 0;

export const payouts = createPayoutsService({
  db,
  repo: createPayoutsRepo(db),
  provider: payoutProvider,
  box,
  limiter: { consume },
  jobs: {
    async verifyAccount(accountId, delayMs) {
      await queue(QUEUES.payments).add(
        'verify-payout-account',
        { accountId },
        { ...defaultJobOptions, delay: delayMs, jobId: `verify-payout-account-${accountId}-${Date.now()}` },
      );
    },
    async checkPayout(payoutId, delayMs) {
      await queue(QUEUES.payments).add(
        'check-payout',
        { payoutId },
        { ...defaultJobOptions, attempts: 5, delay: delayMs, jobId: `check-payout-${payoutId}-${Date.now()}` },
      );
    },
  },
  async notify(userId, key, payload) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, key, payload as never, { kind: 'route', route: 'organizer_payouts' });
  },
  async alert(subject, text) {
    // payouts R12 — one email an hour at most; the log line is every time.
    logger.error({ subject }, text);
    if (!config.PAYOUT_ALERT_EMAIL || Date.now() - lastAlertAt < 3_600_000) return;
    lastAlertAt = Date.now();
    await email.send({ to: config.PAYOUT_ALERT_EMAIL, subject, text });
  },
  async isStaff(userId) {
    const { identity } = await import('../identity/index.js');
    return (await identity.platformRoleFor(userId)) !== null;
  },
  config: {
    autoThreshold: config.PAYOUT_NAME_MATCH_AUTO,
    commissionGstBps: config.COMMISSION_GST_BPS ?? 0,
    tdsBps: config.HOST_TDS_BPS ?? 0,
    impsMaxPaise: config.PAYOUT_IMPS_MAX_PAISE,
  },
});

export { PayoutCode } from './service/payouts.js';
export type { PayoutAccountView, PayoutsService, Staff } from './service/payouts.js';
```

Add `import { logger } from '../../platform/logging/index.js';` and `import { SystemError } from '../../platform/errors/index.js';`. Confirm `notifications.emit`'s signature with `grep -n "async function emit\b\|emit(" src/modules/notifications/service/index.ts | head -3`; if its key parameter is typed `TemplateKey`, the `as never` cast becomes unnecessary once Task 8 adds the two templates — remove it then.

In `src/modules/events/index.ts`, replace the `publishGate` body:

```ts
/**
 * events R10 — a paid category needs a verified payout account (payouts R5).
 * payments decides; staff still pass, as before.
 */
const publishGate: PublishGate = {
  async canPublishPaid(userId) {
    const { payouts } = await import('../payments/index.js');
    return payouts.canPublishPaid(userId);
  },
};
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run tests/payouts.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm test`
Expected: PASS. `tests/events.test.ts` builds its own gate, so it is unaffected.

- [ ] **Step 10: Commit**

```bash
git add src/modules/payments src/modules/events/index.ts tests/helpers tests/payouts.test.ts
git commit -m "feat(payouts): payout accounts, the bank check, staff review and the paid publish gate (payouts R1–R7)"
```

---

### Task 7: Settlement, sending, status, holds and receivables

**Files:**
- Modify: `src/modules/payments/service/payouts.ts`, `tests/payouts.test.ts`

**Interfaces:**
- Consumes: Task 6's service internals, Task 5's `payoutQuote`, repo methods from Task 6.
- Produces (added to `PayoutsService`):

```ts
export const SETTLE_DELAY_MS = 72 * 3_600_000;
export const STALE_SENDING_MS = 30 * 60_000;
export type PayoutStatus = 'scheduled' | 'held' | 'awaiting_funds' | 'sending' | 'paid' | 'failed';
export interface PayoutView {
  id: string; eventId: string; status: PayoutStatus; holdReason: string | null;
  entryFeesPaise: bigint; refundsPaise: bigint; commissionPaise: bigint; commissionTaxPaise: bigint;
  tdsPaise: bigint; receivablesPaise: bigint; amountPaise: bigint;
  dueAt: Date; sentAt: Date | null; paidAt: Date | null; lastError: string | null;
}
//   scheduleForEvent(eventId: string): Promise<PayoutView | null>
//   settleDue(): Promise<{ sent: number; held: number; waiting: number }>
//   sendPayout(payoutId: string): Promise<PayoutStatus>
//   checkPayout(payoutId: string): Promise<PayoutStatus>
//   checkByRef(ref: string): Promise<void>
//   sweepSending(): Promise<number>
//   onRefundProcessed(refundId: string): Promise<void>
//   holdPayout(staff: Staff, id: string, reason: string): Promise<PayoutView>
//   releasePayout(staff: Staff, id: string): Promise<PayoutView>
//   retryPayout(staff: Staff, id: string): Promise<PayoutView>
//   payoutForEvent(eventId: string): Promise<PayoutView | null>   // the quote so far if not yet sent
//   myPayouts(userId: string, page: { first: number; after: string | null }): Promise<{ nodes: PayoutView[]; hasNextPage: boolean }>
//   payoutsNeedingAttention(staff: Staff): Promise<PayoutView[]>
//   openReceivables(staff: Staff): Promise<{ payoutAccountId: string; userId: string; openPaise: bigint }[]>
```

- [ ] **Step 1: Write the failing settlement tests**

Append to `tests/payouts.test.ts`:

```ts
// --- settlement (R8–R15) ------------------------------------------------------

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

/** A verified host with a published paid event and `entries` paid entries. */
async function hostedEvent(entries = 2) {
  const host = await makeUser('Rahul Sharma');
  const account = await payouts.saveAccount(host, RAHUL);
  provider.checks.push(exists(96));
  await payouts.verifyAccount(account.id);

  const actor = { userId: host.userId };
  const event = await events.create(actor, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `Open ${newId().slice(0, 8)}`,
    city: 'Bengaluru',
    startsAt: soon(30),
    endsAt: soon(31),
    registrationClosesAt: soon(25),
    cancellationCutoffAt: soon(20),
  });
  const category = await events.addCategory(actor, event.id, {
    name: 'Open',
    format: 'singles',
    capacity: 16,
    minEntries: 1,
    entryFeePaise: 50_000n,
    platformFeePaise: 5_000n,
    taxBps: 1800,
    skillMin: null,
    skillMax: null,
  });
  await events.publish(actor, event.id);

  const regs: string[] = [];
  for (let i = 0; i < entries; i++) {
    const player = await makeUser(`Player ${i}`);
    await prisma.playerSport.create({ data: { playerId: player.playerId, sportId: pickleballId, skillBand: '3.5' } });
    const reg = await registration.begin({ userId: player.userId }, { eventCategoryId: category.id });
    const order = await payments.createOrder({ userId: player.userId }, reg.id);
    const entity = gateway.capture(order.gatewayOrderId);
    await payments.applyCapture(entity);
    regs.push(reg.id);
  }
  return { host, accountId: account.id, eventId: event.id, regs };
}

/** Ends the event and moves the clock past R8's 72 hours. */
async function endAndComeDue(eventId: string) {
  await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date(Date.now() - 73 * 3_600_000) } });
  return payouts.scheduleForEvent(eventId);
}

describe('payouts R8, R9, R11 — settling an event', () => {
  it('schedules once, 72 h after the event ends', async () => {
    const { eventId } = await hostedEvent();
    await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date('2026-10-10T10:00:00Z') } });
    const first = await payouts.scheduleForEvent(eventId);
    const again = await payouts.scheduleForEvent(eventId);
    expect(first?.dueAt.toISOString()).toBe('2026-10-13T10:00:00.000Z');
    expect(again?.id).toBe(first?.id);
    expect(await prisma.payout.count()).toBe(1);
  });

  it('schedules nothing for a free event', async () => {
    const { eventId } = await hostedEvent(0);
    expect(await payouts.scheduleForEvent(eventId)).toBeNull();
  });

  it('sends the entry fees less 10% to the verified account, and writes the ledger', async () => {
    const { host, eventId } = await hostedEvent(2);
    const scheduled = await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });

    const p = await prisma.payout.findUniqueOrThrow({ where: { id: scheduled!.id } });
    expect(p).toMatchObject({ status: 'sending', amountPaise: 90_000n, commissionPaise: 10_000n, transferRef: p.id });
    expect(provider.transfers).toEqual([{ ref: p.id, amountPaise: 90_000n, accountNumber: '51234567890', mode: 'IMPS' }]);

    const ledger = await prisma.ledgerEntry.findMany({ where: { payoutId: p.id } });
    expect(Object.fromEntries(ledger.map((l) => [l.kind, l.amountPaise]))).toEqual({
      host_commission: 10_000n,
      host_payout: -90_000n,
    });

    provider.succeed(p.id);
    expect(await payouts.checkPayout(p.id)).toBe('paid');
    expect(notified.at(-1)).toMatchObject({ userId: host.userId, key: 'payout.status', payload: { state: 'paid', amountPaise: '90000' } });
  });

  it('does not touch a payout before it is due', async () => {
    const { eventId } = await hostedEvent();
    await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date() } });
    await payouts.scheduleForEvent(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 0 });
  });

  it('pays NEFT above the IMPS ceiling', async () => {
    const { eventId } = await hostedEvent(1);
    await prisma.eventCategory.updateMany({ where: { eventId }, data: { commissionBps: 0 } });
    await prisma.ledgerEntry.updateMany({ where: { kind: 'charge' }, data: { amountPaise: 60_014_900n } });
    await endAndComeDue(eventId);
    await payouts.settleDue();
    expect(provider.transfers[0]?.mode).toBe('NEFT');
  });
});

describe('payouts R10, R7 — holds', () => {
  it('holds while the account is not verified, and releases once it is', async () => {
    const { host, accountId, eventId } = await hostedEvent();
    await payouts.saveAccount(host, { ...RAHUL, accountNumber: '99887766554' }); // back to checking
    const p = await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ status: 'held', holdReason: 'account_not_verified' });
    expect(provider.transfers).toHaveLength(0);

    provider.checks.push(exists(96));
    await payouts.verifyAccount(accountId);
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
    expect(provider.transfers[0]?.accountNumber).toBe('99887766554');
  });

  it('holds while a refund for the event is pending', async () => {
    const { eventId, regs } = await hostedEvent();
    await payments.refundForRegistration({ registrationId: regs[0]!, reason: 'withdrawn' });
    await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
  });

  it('a staff hold is released only by staff', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.holdPayout(finance, p!.id, 'fraud review');
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 0 });
    expect(await errorCode(() => payouts.holdPayout(support, p!.id, 'x'))).toBe('FORBIDDEN');
    await payouts.releasePayout(finance, p!.id);
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
  });

  it('refuses to release a payout that is not held', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    expect(await errorCode(() => payouts.releasePayout(finance, p!.id))).toBe(PayoutCode.PAYOUT_NOT_HELD);
  });
});

describe('payouts R12 — funding', () => {
  it('waits for funds, alerts finance, and sends once topped up', async () => {
    const { eventId } = await hostedEvent();
    provider.balance = 10_000n;
    await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 1 });
    expect(alerts).toHaveLength(1);
    provider.balance = 1_000_000n;
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
  });
});

describe('payouts R11, R13 — exactly once', () => {
  it('concurrent sends move a payout to sending once', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    const results = await Promise.all([payouts.sendPayout(p!.id), payouts.sendPayout(p!.id), payouts.sendPayout(p!.id)]);
    expect(results.filter((s) => s === 'sending')).toHaveLength(1);
    expect(provider.transfers).toHaveLength(1);
  });

  it('timeout after acceptance sends once', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    provider.transferAnswers.push('timeout');
    expect(await payouts.sendPayout(p!.id)).toBe('sending');
    // The sweep and a webhook both look; neither sends again.
    await payouts.settleDue();
    await payouts.checkPayout(p!.id);
    expect(provider.transfers).toHaveLength(1);
    provider.succeed(p!.id);
    expect(await payouts.checkPayout(p!.id)).toBe('paid');
  });

  it('a refused transfer fails, reverses the ledger and alerts', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    provider.transferAnswers.push({ accepted: false, error: 'beneficiary bank down' });
    expect(await payouts.sendPayout(p!.id)).toBe('failed');
    const sum = await prisma.ledgerEntry.aggregate({ where: { payoutId: p!.id }, _sum: { amountPaise: true } });
    expect(sum._sum.amountPaise).toBe(0n);
    expect(alerts.at(-1)).toMatch(/failed/);
  });

  it('a reversed transfer fails and sends the account back to review', async () => {
    const { accountId, eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.sendPayout(p!.id);
    provider.fail(p!.id, 'reversed');
    expect(await payouts.checkPayout(p!.id)).toBe('failed');
    expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ status: 'needs_review' });
  });

  it('staff retry uses a new merchantRefId', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    provider.transferAnswers.push({ accepted: false, error: 'x' });
    await payouts.sendPayout(p!.id);
    expect(await errorCode(() => payouts.retryPayout(support, p!.id))).toBe('FORBIDDEN');
    await payouts.retryPayout(finance, p!.id);
    expect(provider.transfers.map((t) => t.ref)).toEqual([p!.id, `${p!.id}-r2`]);
  });

  it('refuses to retry a payout that has not failed', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    expect(await errorCode(() => payouts.retryPayout(finance, p!.id))).toBe(PayoutCode.PAYOUT_NOT_FAILED);
  });

  it('the stale-sending sweep asks PayU about old transfers', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.sendPayout(p!.id);
    await prisma.payout.update({ where: { id: p!.id }, data: { sentAt: new Date(Date.now() - 31 * 60_000) } });
    provider.succeed(p!.id);
    expect(await payouts.sweepSending()).toBe(1);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ status: 'paid' });
  });

  it('a webhook for an unknown ref changes nothing', async () => {
    await expect(payouts.checkByRef('not-ours')).resolves.toBeUndefined();
  });
});

describe('payouts R15 — refunds after payout', () => {
  it('a refund after the host was paid becomes a receivable netted from the next payout', async () => {
    const first = await hostedEvent(2);
    const p1 = await endAndComeDue(first.eventId);
    await payouts.sendPayout(p1!.id);
    provider.succeed(p1!.id);
    await payouts.checkPayout(p1!.id);

    const refund = await payments.refundForRegistration({ registrationId: first.regs[0]!, reason: 'organizer_goodwill' });
    await payments.settleRefund(refund.id); // the gateway confirms: refund.processed
    await payouts.onRefundProcessed(refund.id);
    const receivable = await prisma.ledgerEntry.findFirstOrThrow({ where: { kind: 'host_receivable' } });
    expect(receivable.amountPaise).toBe(45_000n); // the ₹500 entry fee less its 10%

    // A second event by the same host pays 45_000 less.
    const second = await hostedEventFor(first.host, 2);
    const p2 = await endAndComeDue(second.eventId);
    await payouts.sendPayout(p2!.id);
    expect(provider.transfers.at(-1)?.amountPaise).toBe(90_000n - 45_000n);
  });

  it('a refund before the payout is sent is simply in the quote', async () => {
    const { eventId, regs } = await hostedEvent(2);
    const refund = await payments.refundForRegistration({ registrationId: regs[0]!, reason: 'withdrawn' });
    await payments.settleRefund(refund.id);
    await payouts.onRefundProcessed(refund.id);
    expect(await prisma.ledgerEntry.count({ where: { kind: 'host_receivable' } })).toBe(0);
    await endAndComeDue(eventId);
    await payouts.settleDue();
    expect(provider.transfers[0]?.amountPaise).toBe(45_000n);
  });
});
```

`hostedEventFor(host, entries)` is `hostedEvent` with an existing, already-verified host. Refactor `hostedEvent` into `hostedEventFor(host | null, entries)` in this step: when `host` is `null` it creates and verifies one (the current body); otherwise it skips `makeUser`, `saveAccount` and `verifyAccount`. `hostedEvent(n)` becomes `hostedEventFor(null, n)`.

The tests call two payments test seams. Check they exist with `grep -n "applyCapture\|settleRefund\|refundForRegistration" src/modules/payments/service/index.ts tests/payments.test.ts | head`:
- If `payments.applyCapture` does not exist, replace it with the full path `tests/payments.test.ts` uses: build the webhook with `webhookBody`/`signWebhook` from `tests/helpers/modules.ts`, call `payments.ingestWebhook(raw, { [TEST_SIGNATURE_HEADER]: signature })`, then `payments.applyWebhook(id)`. Copy its `deliver()` helper into this file.
- If `payments.settleRefund` does not exist, settle the refund the way `tests/payments.test.ts` does for `refund.processed` (search it for `'refund.processed'`) and use that.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run tests/payouts.test.ts`
Expected: FAIL — `scheduleForEvent` and the rest are not functions.

- [ ] **Step 3: Implement settlement in the service**

In `src/modules/payments/service/payouts.ts`, add imports:

```ts
import type { Tx } from '../../../platform/db.js';
import { GatewayError } from '../../../platform/payouts/port.js';
import type { PayoutRow } from '../repo/payouts.js';
import { payoutQuote, roundBps, type PayoutQuote } from './payoutQuote.js';
```

Add above `createPayoutsService`:

```ts
/** payouts R8 — result disputes and late withdrawals land first. */
export const SETTLE_DELAY_MS = 72 * 3_600_000;
/** payouts R13 — a transfer we have not heard about in this long gets asked about. */
export const STALE_SENDING_MS = 30 * 60_000;

export type PayoutStatus = 'scheduled' | 'held' | 'awaiting_funds' | 'sending' | 'paid' | 'failed';

export interface PayoutView {
  id: string;
  eventId: string;
  status: PayoutStatus;
  holdReason: string | null;
  entryFeesPaise: bigint;
  refundsPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  tdsPaise: bigint;
  receivablesPaise: bigint;
  amountPaise: bigint;
  dueAt: Date;
  sentAt: Date | null;
  paidAt: Date | null;
  lastError: string | null;
}

const STAFF_HOLD = 'staff:';

function toPayoutView(row: PayoutRow, quote?: PayoutQuote): PayoutView {
  const q = quote ?? row;
  return {
    id: row.id,
    eventId: row.eventId,
    status: row.status as PayoutStatus,
    holdReason: row.holdReason?.startsWith(STAFF_HOLD) ? row.holdReason.slice(STAFF_HOLD.length) : row.holdReason,
    entryFeesPaise: q.entryFeesPaise,
    refundsPaise: q.refundsPaise,
    commissionPaise: q.commissionPaise,
    commissionTaxPaise: q.commissionTaxPaise,
    tdsPaise: q.tdsPaise,
    receivablesPaise: q.receivablesPaise,
    amountPaise: q.amountPaise,
    dueAt: row.dueAt,
    sentAt: row.sentAt,
    paidAt: row.paidAt,
    lastError: row.lastError,
  };
}

/** The rows a sent payout writes (payouts R11). Negated on failure. */
function payoutLedger(payoutId: string, q: PayoutQuote, sign: 1n | -1n) {
  const rows = [
    { kind: 'host_commission', amountPaise: q.commissionPaise },
    { kind: 'commission_tax', amountPaise: q.commissionTaxPaise },
    { kind: 'tds_withheld', amountPaise: q.tdsPaise },
    { kind: 'receivable_recovered', amountPaise: -q.receivablesPaise },
    { kind: 'host_payout', amountPaise: -(q.amountPaise > 0n ? q.amountPaise : 0n) },
  ];
  return rows
    .filter((r) => r.amountPaise !== 0n)
    .map((r) => ({ payoutId, kind: r.kind, amountPaise: r.amountPaise * sign }));
}
```

Inside `createPayoutsService`, before the `return`, add:

```ts
  // --- R8 — scheduling --------------------------------------------------------

  const rates = { commissionGstBps: deps.config.commissionGstBps, tdsBps: deps.config.tdsBps };

  async function quoteFor(payout: PayoutRow, conn: Db | Tx = db): Promise<PayoutQuote> {
    const rows = await repo.quoteRows(payout.eventId, conn);
    const open = await repo.openReceivables(payout.payoutAccountId, conn);
    return payoutQuote(rows, open, rates);
  }

  async function scheduleForEvent(eventId: string): Promise<PayoutView | null> {
    const event = await db.event.findUnique({ where: { id: eventId }, select: { organizerId: true, endsAt: true } });
    if (!event) return null;
    const rows = await repo.quoteRows(eventId);
    // A free event has nothing to settle; a fully refunded one settles to zero.
    if (!rows.some((r) => r.kind === 'charge')) return null;
    const account = await repo.accountByUser(event.organizerId);
    if (!account) {
      // Paid publishing needs an account (R5), so this is staff-published
      // money with nobody to pay: a person decides.
      await deps.alert('Paid event with no payout account', `Event ${eventId} settled with no payout account for its host.`);
      return null;
    }
    const row = await db.payout.upsert({
      where: { eventId_payoutAccountId: { eventId, payoutAccountId: account.id } },
      create: {
        id: newId(),
        eventId,
        payoutAccountId: account.id,
        dueAt: new Date(event.endsAt.getTime() + SETTLE_DELAY_MS),
      },
      update: {},
    });
    return toPayoutView(row);
  }

  // --- R10–R12 — sending ------------------------------------------------------

  const SENDABLE = ['scheduled', 'held', 'awaiting_funds'];

  async function automaticHold(payout: PayoutRow, conn: Db | Tx): Promise<string | null> {
    const account = await repo.accountById(payout.payoutAccountId, conn);
    if (account?.status !== 'verified') return 'account_not_verified';
    if ((await repo.pendingRefundCount(payout.eventId, conn)) > 0) return 'refunds_pending';
    return null;
  }

  async function sendPayout(payoutId: string): Promise<PayoutStatus> {
    // Phase 1, under the row lock: decide, freeze the quote, write the ledger,
    // move to `sending`. Only one caller can win this (payments R15).
    type Plan =
      | { kind: 'done'; status: PayoutStatus }
      | { kind: 'send'; payout: PayoutRow; quote: PayoutQuote };

    const balance = await provider.availablePaise().catch(() => null);

    const plan: Plan = await db.$transaction(async (tx) => {
      const payout = await repo.lockPayout(tx, payoutId);
      if (!payout) return { kind: 'done', status: 'failed' as PayoutStatus };
      if (!SENDABLE.includes(payout.status)) return { kind: 'done', status: payout.status as PayoutStatus };
      if (payout.holdReason?.startsWith(STAFF_HOLD)) return { kind: 'done', status: 'held' as PayoutStatus };
      if (payout.dueAt > now()) return { kind: 'done', status: payout.status as PayoutStatus };

      const hold = await automaticHold(payout, tx);
      if (hold) {
        await tx.payout.update({ where: { id: payout.id }, data: { status: 'held', holdReason: hold } });
        return { kind: 'done', status: 'held' as PayoutStatus };
      }

      const quote = await quoteFor(payout, tx);
      const frozen = {
        entryFeesPaise: quote.entryFeesPaise,
        refundsPaise: quote.refundsPaise,
        commissionPaise: quote.commissionPaise,
        commissionTaxPaise: quote.commissionTaxPaise,
        tdsPaise: quote.tdsPaise,
        receivablesPaise: quote.receivablesPaise,
        amountPaise: quote.amountPaise > 0n ? quote.amountPaise : 0n,
        holdReason: null,
      };

      if (quote.amountPaise <= 0n) {
        // Nothing to transfer. A shortfall carries forward (R9).
        await tx.ledgerEntry.createMany({ data: payoutLedger(payout.id, quote, 1n) });
        if (quote.amountPaise < 0n) {
          await tx.ledgerEntry.create({ data: { payoutId: payout.id, kind: 'host_receivable', amountPaise: -quote.amountPaise } });
        }
        await tx.payout.update({ where: { id: payout.id }, data: { ...frozen, status: 'paid', paidAt: now() } });
        return { kind: 'done', status: 'paid' as PayoutStatus };
      }

      if (balance === null || balance < quote.amountPaise) {
        await tx.payout.update({ where: { id: payout.id }, data: { ...frozen, status: 'awaiting_funds' } });
        return { kind: 'done', status: 'awaiting_funds' as PayoutStatus };
      }

      const attempt = payout.attempts + 1;
      const transferRef = attempt === 1 ? payout.id : `${payout.id}-r${attempt}`;
      await tx.ledgerEntry.createMany({ data: payoutLedger(payout.id, quote, 1n) });
      const sending = await tx.payout.update({
        where: { id: payout.id },
        data: { ...frozen, status: 'sending', attempts: attempt, transferRef, sentAt: now(), lastError: null },
      });
      return { kind: 'send', payout: sending, quote };
    });

    if (plan.kind === 'done') {
      if (plan.status === 'awaiting_funds') {
        await deps.alert('Top up the PayU payouts account', `Payout ${payoutId} is waiting for funds.`);
      }
      return plan.status;
    }

    // Phase 2, outside any transaction: talk to PayU.
    const account = (await repo.accountById(plan.payout.payoutAccountId))!;
    try {
      const result = await provider.transfer({
        ref: plan.payout.transferRef!,
        accountNumber: box.open(account.accountCipher),
        ifsc: account.ifsc,
        name: account.legalName,
        amountPaise: plan.quote.amountPaise,
        mode: plan.quote.amountPaise > deps.config.impsMaxPaise ? 'NEFT' : 'IMPS',
        purpose: 'PL4Y host payout',
      });
      if (!result.accepted) {
        await failPayout(plan.payout.id, result.error ?? 'refused', false);
        return 'failed';
      }
    } catch (err) {
      // Unknown outcome: PayU may have taken it. Stay `sending`; the status
      // check decides, and the transferRef stops a second send (R11).
      if (!(err instanceof GatewayError)) throw err;
      logger.warn({ err, payoutId }, 'payout transfer outcome unknown; checking later');
    }
    await deps.jobs.checkPayout(plan.payout.id, 5 * 60_000);
    return 'sending';
  }

  async function failPayout(payoutId: string, error: string, reversed: boolean): Promise<void> {
    const payout = await db.$transaction(async (tx) => {
      const row = await repo.lockPayout(tx, payoutId);
      if (!row || row.status !== 'sending') return null;
      await tx.ledgerEntry.createMany({ data: payoutLedger(row.id, row, -1n) });
      await tx.payout.update({ where: { id: row.id }, data: { status: 'failed', lastError: error } });
      if (reversed) {
        await tx.payoutAccount.update({
          where: { id: row.payoutAccountId },
          data: { status: 'needs_review', statusReason: 'payout_reversed_by_bank' },
        });
      }
      return row;
    });
    if (!payout) return;
    const account = await repo.accountById(payout.payoutAccountId);
    const event = await db.event.findUnique({ where: { id: payout.eventId }, select: { title: true } });
    if (account) {
      await deps.notify(account.userId, 'payout.status', {
        eventTitle: event?.title ?? '',
        state: 'failed',
        amountPaise: payout.amountPaise.toString(),
      });
    }
    await deps.alert('Host payout failed', `Payout ${payoutId} failed: ${error}`);
  }

  async function settleDue(): Promise<{ sent: number; held: number; waiting: number }> {
    const counts = { sent: 0, held: 0, waiting: 0 };
    for (const p of await repo.duePayouts(now())) {
      try {
        const status = await sendPayout(p.id);
        if (status === 'sending' || status === 'paid') counts.sent += 1;
        else if (status === 'held' && !p.holdReason?.startsWith(STAFF_HOLD)) counts.held += 1;
        else if (status === 'awaiting_funds') counts.waiting += 1;
      } catch (err) {
        logger.error({ err, payoutId: p.id }, 'payout send failed');
      }
    }
    return counts;
  }

  // --- R13 — final status -----------------------------------------------------

  async function checkPayout(payoutId: string): Promise<PayoutStatus> {
    const payout = await repo.payoutById(payoutId);
    if (!payout?.transferRef || payout.status !== 'sending') return (payout?.status ?? 'failed') as PayoutStatus;
    const status = await provider.transferStatus(payout.transferRef);
    await db.payout.update({
      where: { id: payout.id },
      data: { providerStatus: status.providerStatus, providerRef: status.providerRef },
    });
    if (status.state === 'success') {
      const updated = await db.payout.updateMany({
        where: { id: payout.id, status: 'sending' },
        data: { status: 'paid', paidAt: now() },
      });
      if (updated.count === 1) {
        const account = await repo.accountById(payout.payoutAccountId);
        const event = await db.event.findUnique({ where: { id: payout.eventId }, select: { title: true } });
        if (account) {
          await deps.notify(account.userId, 'payout.status', {
            eventTitle: event?.title ?? '',
            state: 'paid',
            amountPaise: payout.amountPaise.toString(),
          });
        }
      }
      return 'paid';
    }
    if (status.state === 'failed' || status.state === 'reversed') {
      await failPayout(payout.id, status.message ?? status.providerStatus ?? status.state, status.state === 'reversed');
      return 'failed';
    }
    return 'sending';
  }

  async function checkByRef(ref: string): Promise<void> {
    const payout = await repo.payoutByRef(ref);
    if (payout) await deps.jobs.checkPayout(payout.id, 0);
  }

  async function sweepSending(): Promise<number> {
    let checked = 0;
    for (const p of await repo.staleSending(new Date(now().getTime() - STALE_SENDING_MS))) {
      try {
        await checkPayout(p.id);
        checked += 1;
      } catch (err) {
        logger.warn({ err, payoutId: p.id }, 'payout status check failed');
      }
    }
    return checked;
  }

  // --- R15 — refunds after payout ---------------------------------------------

  async function onRefundProcessed(refundId: string): Promise<void> {
    const rows = await repo.refundLedger(refundId);
    const registrationId = rows[0]?.registrationId;
    if (!registrationId) return;
    const reg = await db.registration.findUnique({
      where: { id: registrationId },
      select: { eventId: true, eventCategory: { select: { commissionBps: true } } },
    });
    if (!reg) return;
    const payout = await repo.payoutForEvent(reg.eventId);
    // Not yet sent: the refund is simply in the quote when it is.
    if (!payout || !['sending', 'paid'].includes(payout.status)) return;
    // Entry-fee part of this refund: the refund less any fee and tax it
    // reversed. All three rows are negative, so the reversals are ADDED back
    // (a full ₹649 refund is ₹500 of entry fee, not ₹798).
    const refunded = rows.reduce((sum, r) => {
      if (r.kind === 'refund') return sum - r.amountPaise;
      if (r.kind === 'fee_reversal' || r.kind === 'tax_reversal') return sum + r.amountPaise;
      return sum;
    }, 0n);
    if (refunded <= 0n) return;
    const owed = refunded - roundBps(refunded, reg.eventCategory.commissionBps);
    await db.ledgerEntry.create({ data: { payoutId: payout.id, kind: 'host_receivable', amountPaise: owed } });
  }

  // --- R10, R13 — staff ---------------------------------------------------------

  async function holdPayout(staff: Staff, id: string, reason: string): Promise<PayoutView> {
    requireDecider(staff);
    const updated = await db.payout.updateMany({
      where: { id, status: { in: SENDABLE } },
      data: { status: 'held', holdReason: `${STAFF_HOLD}${reason.trim()}` },
    });
    if (updated.count === 0) throw new UserError(PayoutCode.PAYOUT_NOT_HELD, 'Only a payout that has not been sent can be held.');
    return toPayoutView((await repo.payoutById(id))!);
  }

  async function releasePayout(staff: Staff, id: string): Promise<PayoutView> {
    requireDecider(staff);
    const updated = await db.payout.updateMany({
      where: { id, status: 'held' },
      data: { status: 'scheduled', holdReason: null },
    });
    if (updated.count === 0) throw new UserError(PayoutCode.PAYOUT_NOT_HELD, 'That payout is not held.');
    return toPayoutView((await repo.payoutById(id))!);
  }

  async function retryPayout(staff: Staff, id: string): Promise<PayoutView> {
    requireDecider(staff);
    const updated = await db.payout.updateMany({ where: { id, status: 'failed' }, data: { status: 'scheduled' } });
    if (updated.count === 0) throw new UserError(PayoutCode.PAYOUT_NOT_FAILED, 'Only a failed payout can be retried.');
    await sendPayout(id);
    return toPayoutView((await repo.payoutById(id))!);
  }

  // --- R14 — reads ----------------------------------------------------------

  async function payoutForEvent(eventId: string): Promise<PayoutView | null> {
    const row = await repo.payoutForEvent(eventId);
    if (!row) return null;
    // Until it is sent, show the live quote: refunds still change it.
    return SENDABLE.includes(row.status) ? toPayoutView(row, await quoteFor(row)) : toPayoutView(row);
  }

  async function myPayouts(
    userId: string,
    page: { first: number; after: string | null },
  ): Promise<{ nodes: PayoutView[]; hasNextPage: boolean }> {
    const account = await repo.accountByUser(userId);
    if (!account) return { nodes: [], hasNextPage: false };
    const rows = await repo.payoutsForAccount(account.id, page.first, page.after);
    return { nodes: rows.slice(0, page.first).map((r) => toPayoutView(r)), hasNextPage: rows.length > page.first };
  }

  async function payoutsNeedingAttention(staff: Staff): Promise<PayoutView[]> {
    requireDecider(staff);
    return (await repo.heldOrFailed()).map((r) => toPayoutView(r));
  }

  async function openReceivables(staff: Staff): Promise<{ payoutAccountId: string; userId: string; openPaise: bigint }[]> {
    requireDecider(staff);
    const rows = await db.$queryRaw<{ payout_account_id: string; user_id: string; open: bigint }[]>`
      SELECT p.payout_account_id, pa.user_id, SUM(le.amount_paise) AS open
        FROM ledger_entries le
        JOIN payouts p ON p.id = le.payout_id
        JOIN payout_accounts pa ON pa.id = p.payout_account_id
       WHERE le.kind IN ('host_receivable', 'receivable_recovered')
       GROUP BY p.payout_account_id, pa.user_id
      HAVING SUM(le.amount_paise) > 0`;
    return rows.map((r) => ({ payoutAccountId: r.payout_account_id, userId: r.user_id, openPaise: r.open }));
  }
```

Add all of these to the returned object.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/payouts.test.ts && pnpm typecheck`
Expected: PASS. If `concurrent sends` sees more than one transfer, `lockPayout` is not inside the transaction that updates the row — check it is called with `tx`.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/payments/service/payouts.ts tests/payouts.test.ts
git commit -m "feat(payouts): settlement, transfers, status checks, holds and receivables (payouts R8–R15)"
```

---

### Task 8: GraphQL, webhook, worker, notifications, deletion guard, docs

**Files:**
- Create: `src/modules/payments/schema/payouts.ts`, `src/platform/webhooks/payouts.ts`
- Modify: `src/modules/payments/schema/index.ts` (one import), `src/app.ts`, `src/worker.ts`, `src/modules/notifications/templates.ts`, `src/modules/identity/index.ts`, `src/platform/logging/index.ts`, `src/modules/events/schema/index.ts` (HostedEvent payout field), `docs/modules/07-payments.md`, `docs/modules/05-events.md`, `.env.example`
- Test: `tests/payouts.test.ts` (deletion guard), `src/platform/logging/redaction.test.ts`

**Interfaces:**
- Consumes: `payouts` from `src/modules/payments/index.ts`; `ctx.loaders.platformRole.load(userId)` from `src/graphql/context.ts`.
- Produces GraphQL:

```graphql
type PayoutAccount { id: ID! legalName: String! panMasked: String! accountMasked: String! ifsc: String!
  status: PayoutAccountStatus! statusReason: String bankNameReturned: String nameMatch: Int verifiedAt: DateTime }
enum PayoutAccountStatus { CHECKING VERIFIED NEEDS_REVIEW REJECTED SUSPENDED }
type Payout { id: ID! eventId: ID! status: PayoutStatus! holdReason: String entryFeesPaise: Int! refundsPaise: Int!
  commissionPaise: Int! commissionTaxPaise: Int! tdsPaise: Int! receivablesPaise: Int! amountPaise: Int!
  dueAt: DateTime! sentAt: DateTime paidAt: DateTime lastError: String }
enum PayoutStatus { SCHEDULED HELD AWAITING_FUNDS SENDING PAID FAILED }
type PayoutAccountPayload { account: PayoutAccount userError: UserError }
type PayoutPayload { payout: Payout userError: UserError }
type OpenReceivable { payoutAccountId: ID! userId: ID! openPaise: Int! }
Query.myPayoutAccount: PayoutAccount
Query.myPayouts(first: Int = 20, after: String): PayoutConnection!
Query.payoutAccountsForReview: [PayoutAccount!]!           # staff
Query.payoutsNeedingAttention: [Payout!]!                   # admin, finance
Query.openReceivables: [OpenReceivable!]!                   # admin, finance
Mutation.savePayoutAccount(legalName: String!, pan: String!, accountNumber: String!, ifsc: String!): PayoutAccountPayload!
Mutation.approvePayoutAccount(id: ID!): PayoutAccountPayload!
Mutation.rejectPayoutAccount(id: ID!, reason: String!): PayoutAccountPayload!
Mutation.suspendPayoutAccount(id: ID!, reason: String!): PayoutAccountPayload!
Mutation.reinstatePayoutAccount(id: ID!): PayoutAccountPayload!
Mutation.holdPayout(id: ID!, reason: String!): PayoutPayload!
Mutation.releasePayout(id: ID!): PayoutPayload!
Mutation.retryPayout(id: ID!): PayoutPayload!
HostedEvent.payout: Payout
```

- [ ] **Step 1: Write the failing redaction and deletion-guard tests**

Create `src/platform/logging/redaction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { REDACT_PATHS } from './index.js';

describe('payouts R2 — logs never carry bank details', () => {
  it('redacts PAN and account numbers wherever they appear', () => {
    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, { write: (l: string) => lines.push(l) });
    log.info({ input: { pan: 'ABCPS1234K', accountNumber: '51234567890' }, body: { beneficiaryAccountNumber: '51234567890' } });
    expect(lines.join('')).not.toMatch(/ABCPS1234K|51234567890/);
  });
});
```

Append to `tests/payouts.test.ts`:

```ts
describe('payouts R16 — account deletion', () => {
  it('blocks deletion while the host owes a receivable', async () => {
    const { payoutsDeletionGuard } = await import('../src/modules/payments/service/payouts.js');
    const first = await hostedEvent(1);
    const p = await endAndComeDue(first.eventId);
    await payouts.sendPayout(p!.id);
    provider.succeed(p!.id);
    await payouts.checkPayout(p!.id);
    expect(await payoutsDeletionGuard(prisma as never)(first.host.userId)).toEqual([]);
    await prisma.ledgerEntry.create({ data: { payoutId: p!.id, kind: 'host_receivable', amountPaise: 100n } });
    expect(await payoutsDeletionGuard(prisma as never)(first.host.userId)).toEqual(['OPEN_HOST_RECEIVABLE']);
  });

  it('blocks deletion while a payout is still owed', async () => {
    const { payoutsDeletionGuard } = await import('../src/modules/payments/service/payouts.js');
    const { host, eventId } = await hostedEvent(1);
    await endAndComeDue(eventId);
    expect(await payoutsDeletionGuard(prisma as never)(host.userId)).toEqual(['PAYOUT_OWED']);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/platform/logging/redaction.test.ts tests/payouts.test.ts -t "R16|bank details"`
Expected: FAIL — `REDACT_PATHS` and `payoutsDeletionGuard` are not exported.

- [ ] **Step 3: Redaction**

In `src/platform/logging/index.ts`, move the `paths` array to an exported constant and add the payout fields:

```ts
/** payouts R2 adds the bank details; everything else predates it. */
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
  // …keep every existing entry exactly as it is…
  'pan',
  '*.pan',
  'accountNumber',
  '*.accountNumber',
  '*.beneficiaryAccountNumber',
  '*[*].beneficiaryAccountNumber',
];
```

and use `redact: { paths: REDACT_PATHS, censor: '[redacted]' }`. Copy the existing list from the file verbatim first; the snippet above shows only its start.

- [ ] **Step 4: The deletion guard**

Append to `src/modules/payments/service/payouts.ts`:

```ts
/**
 * payouts R16 — identity R18's deletion guard. A host who is still owed money,
 * or who owes some back, cannot vanish.
 */
export function payoutsDeletionGuard(db: Db) {
  return async (userId: string): Promise<string[]> => {
    const account = await db.payoutAccount.findUnique({ where: { userId }, select: { id: true } });
    if (!account) return [];
    const blockers: string[] = [];
    const owed = await db.payout.count({
      where: { payoutAccountId: account.id, status: { in: ['scheduled', 'held', 'awaiting_funds', 'sending', 'failed'] } },
    });
    if (owed > 0) blockers.push('PAYOUT_OWED');
    const [row] = await db.$queryRaw<{ open: bigint | null }[]>`
      SELECT SUM(le.amount_paise) AS open
        FROM ledger_entries le JOIN payouts p ON p.id = le.payout_id
       WHERE p.payout_account_id = ${account.id}::uuid
         AND le.kind IN ('host_receivable', 'receivable_recovered')`;
    if ((row?.open ?? 0n) > 0n) blockers.push('OPEN_HOST_RECEIVABLE');
    return blockers;
  };
}
```

In `src/modules/identity/index.ts`, add a second entry to `deletionGuards`:

```ts
    async (userId) => {
      const { payoutsDeletionGuard } = await import('../payments/service/payouts.js');
      const { db } = await import('../../platform/db.js');
      return payoutsDeletionGuard(db)(userId);
    },
```

- [ ] **Step 5: Notification templates**

In `src/modules/notifications/templates.ts`, add to `TemplatePayloads`:

```ts
  /** payouts R3, R6 — the host's bank details were checked or reviewed. */
  'payout_account.status': { status: 'checking' | 'verified' | 'needs_review' | 'rejected' | 'suspended'; reason: string | null };
  /** payouts R13 — money sent, or a transfer that failed. */
  'payout.status': { eventTitle: string; state: 'paid' | 'failed'; amountPaise: string };
```

and to `TEMPLATES`:

```ts
  'payout_account.status': {
    render: (p) => {
      switch (p.status) {
        case 'verified':
          return { title: "You're set to get paid", body: 'Your bank account is verified. You can publish paid events.' };
        case 'needs_review':
          return { title: "We're checking your details", body: 'Our team is reviewing your bank details. This usually takes a day.' };
        case 'rejected':
          return { title: 'Check your bank details', body: p.reason ?? 'We could not verify your bank account.' };
        case 'suspended':
          return { title: 'Payouts paused', body: p.reason ?? 'Payouts to your account are paused. Contact support.' };
        default:
          return { title: 'Checking your bank details', body: 'This usually takes under a minute.' };
      }
    },
  },
  'payout.status': {
    render: (p) => {
      const rupees = `₹${(Number(p.amountPaise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
      return p.state === 'paid'
        ? { title: `${rupees} sent to your bank`, body: `Your earnings from ${p.eventTitle}.` }
        : { title: 'Payout failed', body: `We couldn't send your earnings from ${p.eventTitle}. We're looking into it.` };
    },
  },
```

Remove the `as never` cast added in Task 6 Step 7 if typecheck now passes without it.

- [ ] **Step 6: GraphQL**

Create `src/modules/payments/schema/payouts.ts`:

```ts
/**
 * payouts — GraphQL (spec 2026-10-02-host-payouts). Hosts see their own
 * account, masked, and their payouts. Staff operations are here for the admin
 * web app; the player app never calls them.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import type { Ctx } from '../../../graphql/context.js';
import { SystemError, forbidden } from '../../../platform/errors/index.js';
import { payouts } from '../index.js';
import type { PayoutAccountView, Staff } from '../index.js';
import type { PayoutView } from '../service/payouts.js';

const paise = (v: bigint): number => Number(v);

async function requireStaff(ctx: Ctx): Promise<Staff> {
  const actor = requireActor(ctx);
  const role = await ctx.loaders.platformRole.load(actor.userId);
  if (role !== 'admin' && role !== 'finance' && role !== 'support') throw forbidden();
  return { userId: actor.userId, role };
}

const PayoutAccountStatusRef = builder.enumType('PayoutAccountStatus', {
  values: {
    CHECKING: { value: 'checking' },
    VERIFIED: { value: 'verified' },
    NEEDS_REVIEW: { value: 'needs_review' },
    REJECTED: { value: 'rejected' },
    SUSPENDED: { value: 'suspended' },
  } as const,
});

const PayoutStatusRef = builder.enumType('PayoutStatus', {
  values: {
    SCHEDULED: { value: 'scheduled' },
    HELD: { value: 'held' },
    AWAITING_FUNDS: { value: 'awaiting_funds' },
    SENDING: { value: 'sending' },
    PAID: { value: 'paid' },
    FAILED: { value: 'failed' },
  } as const,
});

export const PayoutAccountRef = builder.objectRef<PayoutAccountView>('PayoutAccount').implement({
  description: 'payouts R2 — PAN and account number are only ever masked here.',
  fields: (t) => ({
    id: t.exposeID('id'),
    legalName: t.exposeString('legalName'),
    panMasked: t.exposeString('panMasked'),
    accountMasked: t.exposeString('accountMasked'),
    ifsc: t.exposeString('ifsc'),
    status: t.field({ type: PayoutAccountStatusRef, resolve: (a) => a.status }),
    statusReason: t.string({ nullable: true, resolve: (a) => a.statusReason }),
    bankNameReturned: t.string({ nullable: true, resolve: (a) => a.bankNameReturned }),
    nameMatch: t.int({ nullable: true, resolve: (a) => a.nameMatch }),
    verifiedAt: t.field({ type: 'DateTime', nullable: true, resolve: (a) => a.verifiedAt }),
  }),
});

export const PayoutRef = builder.objectRef<PayoutView>('Payout').implement({
  description: 'payouts R9, R14 — the breakdown is the live quote until the transfer is sent, then frozen.',
  fields: (t) => ({
    id: t.exposeID('id'),
    eventId: t.exposeID('eventId'),
    status: t.field({ type: PayoutStatusRef, resolve: (p) => p.status }),
    holdReason: t.string({ nullable: true, resolve: (p) => p.holdReason }),
    entryFeesPaise: t.int({ resolve: (p) => paise(p.entryFeesPaise) }),
    refundsPaise: t.int({ resolve: (p) => paise(p.refundsPaise) }),
    commissionPaise: t.int({ resolve: (p) => paise(p.commissionPaise) }),
    commissionTaxPaise: t.int({ resolve: (p) => paise(p.commissionTaxPaise) }),
    tdsPaise: t.int({ resolve: (p) => paise(p.tdsPaise) }),
    receivablesPaise: t.int({ resolve: (p) => paise(p.receivablesPaise) }),
    amountPaise: t.int({ resolve: (p) => paise(p.amountPaise) }),
    dueAt: t.field({ type: 'DateTime', resolve: (p) => p.dueAt }),
    sentAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.sentAt }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.paidAt }),
    lastError: t.string({ nullable: true, resolve: (p) => p.lastError }),
  }),
});

const PayoutAccountPayload = builder
  .objectRef<{ account: PayoutAccountView | null; userError: UserErrorShape | null }>('PayoutAccountPayload')
  .implement({
    fields: (t) => ({
      account: t.field({ type: PayoutAccountRef, nullable: true, resolve: (p) => p.account }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PayoutPayload = builder
  .objectRef<{ payout: PayoutView | null; userError: UserErrorShape | null }>('PayoutPayload')
  .implement({
    fields: (t) => ({
      payout: t.field({ type: PayoutRef, nullable: true, resolve: (p) => p.payout }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const OpenReceivableRef = builder
  .objectRef<{ payoutAccountId: string; userId: string; openPaise: bigint }>('OpenReceivable')
  .implement({
    fields: (t) => ({
      payoutAccountId: t.exposeID('payoutAccountId'),
      userId: t.exposeID('userId'),
      openPaise: t.int({ resolve: (r) => paise(r.openPaise) }),
    }),
  });

builder.queryFields((t) => ({
  myPayoutAccount: t.field({
    type: PayoutAccountRef,
    nullable: true,
    resolve: async (_root, _args, ctx) => payouts.myAccount(requireActor(ctx).userId),
  }),

  myPayouts: t.connection(
    {
      type: PayoutRef,
      args: {},
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'myPayouts supports forward pagination only');
        }
        const after = args.after ? Buffer.from(args.after, 'base64url').toString('utf8') : null;
        const page = await payouts.myPayouts(actor.userId, { first: clampFirst(args.first, 20), after });
        const edges = page.nodes.map((node) => ({ cursor: Buffer.from(node.id, 'utf8').toString('base64url'), node }));
        return {
          edges,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: edges.at(-1)?.cursor ?? null,
          },
        };
      },
    },
    { name: 'PayoutConnection' },
    { name: 'PayoutEdge' },
  ),

  payoutAccountsForReview: t.field({
    type: [PayoutAccountRef],
    resolve: async (_root, _args, ctx) => payouts.accountsForReview(await requireStaff(ctx)),
  }),

  payoutsNeedingAttention: t.field({
    type: [PayoutRef],
    resolve: async (_root, _args, ctx) => payouts.payoutsNeedingAttention(await requireStaff(ctx)),
  }),

  openReceivables: t.field({
    type: [OpenReceivableRef],
    resolve: async (_root, _args, ctx) => payouts.openReceivables(await requireStaff(ctx)),
  }),
}));

builder.mutationFields((t) => ({
  savePayoutAccount: t.field({
    type: PayoutAccountPayload,
    description: 'payouts R1 — saves (or replaces) the host bank details and starts the bank check.',
    args: {
      legalName: t.arg.string({ required: true }),
      pan: t.arg.string({ required: true }),
      accountNumber: t.arg.string({ required: true }),
      ifsc: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => payouts.saveAccount(actor, args));
      return { account: data, userError };
    },
  }),

  approvePayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.approveAccount(staff, String(args.id)));
      return { account: data, userError };
    },
  }),

  rejectPayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.rejectAccount(staff, String(args.id), args.reason));
      return { account: data, userError };
    },
  }),

  suspendPayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.suspendAccount(staff, String(args.id), args.reason));
      return { account: data, userError };
    },
  }),

  reinstatePayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.reinstateAccount(staff, String(args.id)));
      return { account: data, userError };
    },
  }),

  holdPayout: t.field({
    type: PayoutPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.holdPayout(staff, String(args.id), args.reason));
      return { payout: data, userError };
    },
  }),

  releasePayout: t.field({
    type: PayoutPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.releasePayout(staff, String(args.id)));
      return { payout: data, userError };
    },
  }),

  retryPayout: t.field({
    type: PayoutPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const { data, userError } = await attempt(() => payouts.retryPayout(staff, String(args.id)));
      return { payout: data, userError };
    },
  }),
}));
```

At the end of `src/modules/payments/schema/index.ts` add `import './payouts.js';`. Check how `src/schema.ts` imports module schemas (`grep -n "schema/index" src/schema.ts`); if it imports each module schema file explicitly instead, add `import './modules/payments/schema/payouts.js';` there instead.

Add the `HostedEvent.payout` field from the payouts schema file, so `events` never imports `payments`. Find the hosted-event object ref with `grep -n "'HostedEvent'" src/modules/events/schema/index.ts` and export it as `HostedEventRef` if it is not exported already. Then in `src/modules/payments/schema/payouts.ts`, after `PayoutRef`, add:

```ts
// payouts R14 — the manage screen's payout line. Registered here so `events`
// does not import `payments`.
builder.objectField(HostedEventRef, 'payout', (t) =>
  t.field({
    type: PayoutRef,
    nullable: true,
    resolve: async (event) => payouts.payoutForEvent(event.id),
  }),
);
```

with `import { HostedEventRef } from '../../events/schema/index.js';` — export `HostedEventRef` from the events schema if it is not already exported (it is the `builder.objectRef<...>('HostedEvent')` value).

- [ ] **Step 7: The webhook route**

Create `src/platform/webhooks/payouts.ts`:

```ts
/**
 * PayU Payouts webhook (payouts R13). A hint, never the truth: the body names
 * a merchantRefId and nothing else is believed. The status always comes from
 * PayU's status API in the `check-payout` job. Answers 200 fast either way, so
 * PayU does not retry what we have already queued.
 */
import type { Request, Response } from 'express';
import { logger } from '../logging/index.js';
import { payoutProvider, payoutsConfigured } from '../payouts/index.js';
import { payouts } from '../../modules/payments/index.js';

export async function payoutsWebhook(req: Request, res: Response): Promise<void> {
  if (!payoutsConfigured()) {
    res.status(503).send('not configured');
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const ref = payoutProvider.refFromWebhook(raw);
  if (!ref) {
    logger.warn('payouts webhook without a merchantRefId');
    res.status(200).send('ignored');
    return;
  }
  await payouts.checkByRef(ref);
  res.status(200).send('ok');
}
```

In `src/app.ts`, after the `/webhooks/payments` route:

```ts
  // payouts R13 — raw, like the others, so the body is ours to read once.
  app.post(
    '/webhooks/payouts',
    express.raw({ type: '*/*' }),
    (req, res, next) => {
      payoutsWebhook(req, res).catch(next);
    },
  );
```

with `import { payoutsWebhook } from './platform/webhooks/payouts.js';`.

- [ ] **Step 8: Worker jobs, schedules and outbox hooks**

In `src/worker.ts`:

1. Import `payouts` alongside `payments`: `import { payments, payouts } from './modules/payments/index.js';`
2. Replace the `'event.completed'` handler:

```ts
  'event.completed': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    if (!eventId) return;
    // payouts R8 — the host's payout falls due 72 h from now.
    await payouts.scheduleForEvent(eventId);
  },
```

3. In `'event.cancelled'`, after the bulk-refund `add`, add `await payouts.scheduleForEvent(eventId);` — a cancelled event's refunds net it to zero, and a zero payout closes itself (R9).
4. In `'refund.processed'`, add first:

```ts
    // payouts R15 — a refund after the host was paid becomes a receivable.
    const refundId = String(payload['refundId'] ?? '');
    if (refundId) await payouts.onRefundProcessed(refundId);
```

5. Add to `SCHEDULES`:

```ts
  // payouts R8, R10, R12 — every minute: due payouts are sent, held or wait for funds.
  [QUEUES.payments, 'settle-due-payouts', '* * * * *'],
  // payouts R13 — transfers we have not heard about in 30 minutes.
  [QUEUES.payments, 'sweep-sending-payouts', '*/15 * * * *'],
```

6. Add cases to the payments worker switch:

```ts
        case 'verify-payout-account': {
          const { accountId } = job.data as { accountId: string };
          await payouts.verifyAccount(accountId);
          return;
        }
        case 'check-payout': {
          const { payoutId } = job.data as { payoutId: string };
          await payouts.checkPayout(payoutId);
          return;
        }
        case 'settle-due-payouts': {
          const result = await payouts.settleDue();
          if (result.sent + result.held + result.waiting > 0) logger.info(result, 'payouts settled');
          return;
        }
        case 'sweep-sending-payouts': {
          const checked = await payouts.sweepSending();
          if (checked > 0) logger.warn({ checked }, 'checked payouts stuck in sending');
          return;
        }
```

- [ ] **Step 9: Docs and env example**

1. `docs/modules/07-payments.md`: in **Owns**, keep `payout_accounts`, `payouts`. Replace the body of **R13** with: "*Superseded 2026-10-02* — hosts are paid through PayU Payouts from the platform's balance, not Split Settlements. See `docs/superpowers/specs/2026-10-02-host-payouts-design.md` (payouts R1–R16)." In **R17**, replace "recovered by a transfer reversal at the payout provider. If the reversal fails, an `organizer_receivable` ledger entry is written" with "written as a `host_receivable` ledger entry (payouts R15)". In the R6 kinds list, add the six new kinds.
2. `docs/modules/05-events.md` **R10**: replace "organizer profile to be `verified` with an active payout account (`organizers R5`, `payments R13`)" with "host's payout account to be `verified` (payouts R5)".
3. `.env.example`: add, commented, every key from Task 1 with a one-line comment each, and `PAYOUT_PROVIDER=mock` as the suggested dev value with `PAYOUT_DATA_KEY` generated by `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

- [ ] **Step 10: Regenerate the schema and run everything**

Run: `pnpm schema:generate && pnpm check`
Expected: `schema.graphql` gains the types above; typecheck, lint, guard and every test pass.

- [ ] **Step 11: Commit**

```bash
git add -A src tests docs schema.graphql .env.example
git commit -m "feat(payouts): GraphQL, webhook, jobs, notifications and deletion guard (payouts R5, R13, R14, R16)"
```

---

### Task 9: PayU sandbox probe

**Files:**
- Create: `scripts/payu-payouts-probe.ts`
- Modify: `src/platform/payouts/payu.ts` only if the probe disagrees with it; `src/platform/payouts/payu.test.ts` to match

**Interfaces:**
- Consumes: `createPayUPayouts` from Task 4.

This task needs PayU Payouts **test** credentials (`PAYU_PAYOUT_MERCHANT_ID`, `_CLIENT_ID`, `_CLIENT_SECRET`) from the PayU account manager. Without them, stop here and report the task as blocked on credentials; Tasks 1–8 are complete and shippable with `PAYOUT_PROVIDER=mock` in development and `none` in production.

- [ ] **Step 1: Write the probe**

Create `scripts/payu-payouts-probe.ts`:

```ts
/**
 * Probes PayU Payouts' SANDBOX with the adapter, the way scripts/payu-probe.ts
 * did for collection. Run by hand; never in CI. Prints what came back so the
 * adapter's assumptions (endpoints, the balance field, txnStatus spellings)
 * are checked against the real thing, not the docs.
 *
 *   PAYU_PAYOUT_MERCHANT_ID=… PAYU_PAYOUT_CLIENT_ID=… PAYU_PAYOUT_CLIENT_SECRET=… \
 *     pnpm tsx scripts/payu-payouts-probe.ts
 */
import { createPayUPayouts } from '../src/platform/payouts/payu.js';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const rawFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.clone().text();
  console.log(`\n${init?.method ?? 'GET'} ${String(url)} → ${res.status}\n${text.slice(0, 2000)}`);
  return res;
};

const provider = createPayUPayouts({
  env: 'test',
  merchantId: env('PAYU_PAYOUT_MERCHANT_ID'),
  clientId: env('PAYU_PAYOUT_CLIENT_ID'),
  clientSecret: env('PAYU_PAYOUT_CLIENT_SECRET'),
  fetch: rawFetch,
});

const ref = `probe-${Date.now()}`;
const bank = { accountNumber: '51234567890', ifsc: 'HDFC0001098', name: 'Ankush Pokarana' };

console.log('balance', await provider.availablePaise());
console.log('verify', await provider.verifyAccount({ ...bank, ref: `v-${ref}` }));
console.log('transfer', await provider.transfer({ ...bank, ref, amountPaise: 100n, mode: 'IMPS', purpose: 'probe' }));
console.log('status', await provider.transferStatus(ref));
```

- [ ] **Step 2: Run it**

Run: `pnpm tsx --env-file-if-exists=.env scripts/payu-payouts-probe.ts`
Expected: four printed responses. Check each against `payu.ts`:
- The transfer endpoint: if the sandbox answers 404 on `/payout/payment` and the docs' `v2/payment` works, change `transfer` to post to `${host.api}/v2/payment` with a `pid` header in test, and record which in the file's header comment.
- The balance: if `balance` is not the spendable figure (compare with `transferableAmount` after a transfer), switch `availablePaise` to the right field.
- `txnStatus` spellings: add any value not in `STATES` to the map.

- [ ] **Step 3: Save the responses as fixtures and pin them**

Copy each printed response into `src/platform/payouts/payu.test.ts` as the scripted answer of the matching test, replacing the doc-derived bodies, and rerun: `pnpm vitest run src/platform/payouts/payu.test.ts` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/payu-payouts-probe.ts src/platform/payouts
git commit -m "chore(payouts): PayU Payouts sandbox probe; adapter pinned to sandbox responses"
```
