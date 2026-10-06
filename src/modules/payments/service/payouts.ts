/**
 * payouts — host verification and payouts (spec 2026-10-02-host-payouts).
 *
 * A second service beside payments' own: it shares the ledger and the module
 * boundary, not the collection state machine. The provider is a port
 * (platform/payouts); nothing here knows RazorpayX's shapes.
 *
 * Money only moves to an account a penny test (or a person) has verified, and
 * a payout id is the transfer's reference, so a retried job can never pay
 * twice (payments R15).
 */
import type { Db, Tx } from '../../../platform/db.js';
import type { SecretBox } from '../../../platform/crypto/secretBox.js';
import { SharedCode, SystemError, UserError, forbidden, illegalTransition } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import { GatewayError, type PayoutProvider } from '../../../platform/payouts/port.js';
import type { PayoutAccountRow, PayoutRow, PayoutsRepo } from '../repo/payouts.js';
import { checkAccountNumber, checkIfsc, checkPan, last4, normaliseUpper, panMatchesSurname } from './pan.js';
import { payoutQuote, type PayoutQuote } from './payoutQuote.js';
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
  /** gap #24 — a suspension is lifted by staff, not by saving details again. */
  PAYOUT_ACCOUNT_SUSPENDED: 'PAYOUT_ACCOUNT_SUSPENDED',
  /** org R6 — only an organisation's owner sets where its money goes. */
  NOT_ORGANISATION_OWNER: 'NOT_ORGANISATION_OWNER',
  /** gap #25 — replacing verified details needs a fresh code from the owner's email. */
  EMAIL_CODE_REQUIRED: 'EMAIL_CODE_REQUIRED',
  EMAIL_CODE_INVALID: 'EMAIL_CODE_INVALID',
  /** Manual payouts — markPayoutPaid's refusals. */
  PAYOUT_NOT_READY: 'PAYOUT_NOT_READY',
  PAYOUT_AMOUNT_MISMATCH: 'PAYOUT_AMOUNT_MISMATCH',
  INVALID_UTR: 'INVALID_UTR',
  UTR_ALREADY_USED: 'UTR_ALREADY_USED',
  /** gap #16 — recordRepayment's refusals. */
  NOTHING_OWED: 'NOTHING_OWED',
  REPAYMENT_TOO_LARGE: 'REPAYMENT_TOO_LARGE',
} as const;

/** payouts R3 — 5 min, 30 min, 2 h; then a person looks. */
export const VERIFY_RETRY_DELAYS_MS = [300_000, 1_800_000, 7_200_000];
/** payouts R1 — every save is a paid penny test. */
export const DETAILS_WINDOW = { seconds: 86_400, max: 5 };

export type AccountStatus = 'checking' | 'verified' | 'needs_review' | 'rejected' | 'suspended';

export interface PayoutAccountView {
  id: string;
  userId: string;
  /** org R6 — set on an organisation's account. */
  organizerProfileId: string | null;
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
  /** gap #25 — when verified details were last replaced; payouts wait 48 h after it. */
  detailsChangedAt: Date | null;
  createdAt: Date;
}

/** Manual payouts — what staff need to send the money themselves. Never reaches the app. */
export interface PayoutAccountDetails {
  id: string;
  legalName: string;
  accountNumber: string;
  ifsc: string;
  status: AccountStatus;
  detailsChangedAt: Date | null;
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
  /** gap #25 — checks a fresh email code. Absent: no step-up (tests that are not about it). */
  stepUp?: { verify(userId: string, code: string): Promise<boolean> };
  /**
   * F3 — what says an event happened, and what says it did not: matches
   * started, players checked in, and players' open reports. Absent: no review
   * holds (tests that are not about them).
   */
  reviewSignals?(eventId: string): Promise<{
    startedMatches: number;
    checkIns: number;
    openReports: number;
    latestReportAt: Date | null;
  }>;
  config: { autoThreshold: number; commissionGstBps: number; tdsBps: number; impsMaxPaise: bigint };
  now?: () => Date;
}

const mask = (clear4: string, total: number): string => 'X'.repeat(total - 4) + clear4;

function toView(row: PayoutAccountRow): PayoutAccountView {
  return {
    id: row.id,
    userId: row.userId,
    organizerProfileId: row.organizerProfileId,
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
    detailsChangedAt: row.detailsChangedAt,
    createdAt: row.createdAt,
  };
}

/** payouts R8 — result disputes and late withdrawals land first. */
export const SETTLE_DELAY_MS = 72 * 3_600_000;
/** F3 — a host's first paid event waits a week: players have longer to report it. */
export const FIRST_PAYOUT_DELAY_MS = 7 * 24 * 3_600_000;
/** gap #25 — how long payouts wait after verified bank details are replaced. */
export const BANK_CHANGE_HOLD_MS = 48 * 3_600_000;
/** payouts R13 — a transfer we have not heard about in this long gets asked about. */
export const STALE_SENDING_MS = 30 * 60_000;

export type PayoutStatus = 'scheduled' | 'held' | 'awaiting_funds' | 'sending' | 'paid' | 'failed';

export interface PayoutView {
  id: string;
  eventId: string;
  payoutAccountId: string;
  status: PayoutStatus;
  holdReason: string | null;
  entryFeesPaise: bigint;
  refundsPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  tdsPaise: bigint;
  receivablesPaise: bigint;
  gatewayFeesPaise: bigint;
  amountPaise: bigint;
  dueAt: Date;
  sentAt: Date | null;
  paidAt: Date | null;
  lastError: string | null;
  /** Manual payouts — waiting for a person to send it from PL4Y's bank. */
  toPayByHand: boolean;
  /** Manual payouts — the bank reference staff recorded when they paid it. */
  utr: string | null;
}

const STAFF_HOLD = 'staff:';
/**
 * Manual payouts — `provider_status` of a payout staff send by hand. It is
 * `sending` with its ledger written, exactly like a transfer RazorpayX
 * accepted, so its amount is frozen and a refund after it becomes a
 * receivable (R15). Nobody is asked about it: a person marks it paid. The
 * marker is on the row, so it survives a switch of provider.
 */
const BY_HAND = 'manual';
/** UPI and IMPS references are 12 digits; NEFT and RTGS UTRs 16 to 22 characters. */
const UTR_PATTERN = /^[A-Z0-9]{6,35}$/;

function toPayoutView(row: PayoutRow, quote?: PayoutQuote): PayoutView {
  const q = quote ?? row;
  return {
    id: row.id,
    eventId: row.eventId,
    payoutAccountId: row.payoutAccountId,
    status: row.status as PayoutStatus,
    holdReason: row.holdReason?.startsWith(STAFF_HOLD) ? row.holdReason.slice(STAFF_HOLD.length) : row.holdReason,
    entryFeesPaise: q.entryFeesPaise,
    refundsPaise: q.refundsPaise,
    commissionPaise: q.commissionPaise,
    commissionTaxPaise: q.commissionTaxPaise,
    tdsPaise: q.tdsPaise,
    receivablesPaise: q.receivablesPaise,
    gatewayFeesPaise: q.gatewayFeesPaise,
    amountPaise: q.amountPaise,
    dueAt: row.dueAt,
    sentAt: row.sentAt,
    paidAt: row.paidAt,
    lastError: row.lastError,
    toPayByHand: row.status === 'sending' && row.providerStatus === BY_HAND,
    utr: row.status === 'paid' && row.providerStatus === BY_HAND ? row.providerRef : null,
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

const ENTRY_KINDS = ['charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal'];

const DECIDERS: Staff['role'][] = ['admin', 'finance'];

function requireDecider(staff: Staff): void {
  if (!DECIDERS.includes(staff.role)) throw forbidden();
}

export function createPayoutsService(deps: PayoutsDeps) {
  const { db, repo, provider, box } = deps;
  const now = deps.now ?? (() => new Date());

  async function accountOrThrow(id: string): Promise<PayoutAccountRow> {
    const row = await repo.accountById(id);
    if (!row) throw new SystemError(SharedCode.NOT_FOUND, 'No such payout account');
    return row;
  }

  async function setStatus(
    id: string,
    status: AccountStatus,
    reason: string | null,
    extra: { reviewedBy?: string } = {},
  ): Promise<PayoutAccountView> {
    // gap #25 — the name a person or the bank check accepted is the one a
    // later change is compared against.
    const accepted = status === 'verified' ? (await accountOrThrow(id)).legalName : undefined;
    const row = await db.payoutAccount.update({
      where: { id },
      data: {
        status,
        statusReason: reason,
        verifiedAt: status === 'verified' ? now() : undefined,
        verifiedLegalName: accepted,
        ...(extra.reviewedBy ? { reviewedBy: extra.reviewedBy, reviewedAt: now() } : {}),
      },
    });
    await deps.notify(row.userId, 'payout_account.status', { status, reason });
    return toView(row);
  }

  // --- R1, R2, R7 — saving --------------------------------------------------

  /** org R6 — an organisation's owner, read from organisations' own table. */
  async function organisationOwner(organizerProfileId: string): Promise<string | null> {
    const row = await db.organizerMember.findFirst({
      where: { organizerProfileId, role: 'owner' },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  async function saveAccount(
    actor: { userId: string },
    input: { legalName: string; pan: string; accountNumber: string; ifsc: string; emailCode?: string | null },
    opts: { organisationId?: string | null } = {},
  ): Promise<PayoutAccountView> {
    const organisationId = opts.organisationId ?? null;
    if (organisationId && (await organisationOwner(organisationId)) !== actor.userId) {
      throw new UserError(PayoutCode.NOT_ORGANISATION_OWNER, "Only the organisation's owner can change where its money goes.");
    }
    const legalName = input.legalName.trim().replace(/\s+/g, ' ');
    const pan = normaliseUpper(input.pan);
    const ifsc = normaliseUpper(input.ifsc);
    const accountNumber = input.accountNumber.trim();

    if (legalName.length < 2) {
      throw new UserError(
        PayoutCode.INVALID_NAME,
        organisationId ? 'Enter the name exactly as it is on the bank account.' : 'Enter your name as it is on your bank account.',
      );
    }
    const panCheck = checkPan(pan);
    if (panCheck === 'INVALID_PAN') throw new UserError(PayoutCode.INVALID_PAN, "That PAN doesn't look right. It's 5 letters, 4 digits, then a letter.");
    // An organisation may be a company, firm or trust; a person must be a person.
    if (panCheck === 'PAN_NOT_INDIVIDUAL' && !organisationId) {
      throw new UserError(PayoutCode.PAN_NOT_INDIVIDUAL, 'Use your personal PAN. Hosting payouts go to individuals.');
    }
    if (!checkIfsc(ifsc)) throw new UserError(PayoutCode.INVALID_IFSC, "That IFSC doesn't look right. It's 11 characters, like HDFC0001234.");
    if (!checkAccountNumber(accountNumber)) throw new UserError(PayoutCode.INVALID_ACCOUNT_NUMBER, 'Account numbers are 9 to 18 digits.');

    const current = organisationId ? await repo.accountByOrganisation(organisationId) : await repo.accountByUser(actor.userId);
    // gap #24 — saving again sets the account back to `checking`, and the
    // bank check could then verify it. A suspension is staff's decision and
    // only staff lift it (reinstatePayoutAccount).
    if (current?.status === 'suspended') {
      throw new UserError(
        PayoutCode.PAYOUT_ACCOUNT_SUSPENDED,
        'Your payout account is suspended, so its details can’t be changed. Please contact support.',
      );
    }

    // gap #25 — replacing details that were already verified is the moment a
    // taken-over session would redirect the money, so it takes a fresh code
    // from the account's own email first. A first save does not.
    if (current?.verifiedLegalName != null && deps.stepUp) {
      const code = input.emailCode?.trim();
      if (!code) {
        throw new UserError(
          PayoutCode.EMAIL_CODE_REQUIRED,
          'To change verified bank details, enter the code we email you. Ask for one first.',
        );
      }
      if (!(await deps.stepUp.verify(actor.userId, code))) {
        throw new UserError(PayoutCode.EMAIL_CODE_INVALID, 'That code is wrong or has expired. Ask for a new one.');
      }
    }

    const limit = await deps.limiter.consume(`payout-details:${actor.userId}`, DETAILS_WINDOW);
    if (!limit.allowed) {
      throw new UserError(PayoutCode.PAYOUT_DETAILS_RATE_LIMITED, 'Too many changes today. Try again tomorrow.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    // gap #25 — replacing details that were already verified is the moment a
    // taken-over account would redirect the money. It is recorded (payouts
    // wait 48 h after it), and the host is told.
    const replacingVerified = current?.verifiedLegalName != null;
    // Manual payouts — no bank check to run: every save goes to a person.
    const byHand = provider.manual === true;

    const fields = {
      legalName,
      // Prisma 6 types Bytes as a plain Uint8Array, not a Buffer.
      panCipher: new Uint8Array(box.seal(pan)),
      panLast4: last4(pan),
      accountCipher: new Uint8Array(box.seal(accountNumber)),
      accountLast4: last4(accountNumber),
      ifsc,
      // The surname letter only exists on a person's PAN. A company's has none
      // to compare, so the bank's name match decides on its own.
      panSurnameOk: pan[3] === 'P' ? panMatchesSurname(pan, legalName) : true,
      status: byHand ? 'needs_review' : 'checking',
      statusReason: byHand ? 'manual_review' : null,
      bankNameReturned: null,
      nameMatch: null,
      verifyRef: null,
      checkAttempts: 0,
      reviewedBy: null,
      reviewedAt: null,
      verifiedAt: null,
      ...(replacingVerified ? { detailsChangedAt: now() } : {}),
    };
    const row = current
      ? await db.payoutAccount.update({ where: { id: current.id }, data: { ...fields, userId: actor.userId } })
      : await db.payoutAccount.create({
          data: { id: newId(), userId: actor.userId, organizerProfileId: organisationId, ...fields },
        });
    if (replacingVerified) {
      await deps.notify(actor.userId, 'payout_account.status', {
        status: fields.status,
        reason: 'Your payout bank details were changed. If this was not you, contact support now.',
      });
    } else if (byHand) {
      await deps.notify(actor.userId, 'payout_account.status', { status: 'needs_review', reason: null });
    }
    if (!byHand) await deps.jobs.verifyAccount(row.id, 0);
    return toView(row);
  }

  async function myAccount(userId: string): Promise<PayoutAccountView | null> {
    const row = await repo.accountByUser(userId);
    return row ? toView(row) : null;
  }

  async function organisationAccount(organizerProfileId: string): Promise<PayoutAccountView | null> {
    const row = await repo.accountByOrganisation(organizerProfileId);
    return row ? toView(row) : null;
  }

  /**
   * org R2 — ownership moved (staff only). The account and its notices follow
   * the new owner; the bank details stay until the new owner changes them.
   */
  async function setOrganisationAccountHolder(organizerProfileId: string, userId: string, tx?: Tx): Promise<void> {
    await (tx ?? db).payoutAccount.updateMany({ where: { organizerProfileId }, data: { userId } });
  }

  /**
   * org R6 — who an event's money goes to: the organisation it is hosted as,
   * or the person who hosts it. 014's personal profiles stand for the person.
   */
  async function payeeAccountFor(eventId: string, conn: Db | Tx = db): Promise<PayoutAccountRow | null> {
    const event = await conn.event.findUnique({
      where: { id: eventId },
      select: { organizerId: true, organizerProfileId: true },
    });
    if (!event) return null;
    if (event.organizerProfileId) {
      const org = await conn.organizerProfile.findUnique({
        where: { id: event.organizerProfileId },
        select: { isPersonal: true },
      });
      if (org && !org.isPersonal) return repo.accountByOrganisation(event.organizerProfileId, conn);
    }
    return repo.accountByUser(event.organizerId, conn);
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
    // Manual payouts — a check queued before the switch goes to a person instead.
    if (provider.manual) {
      await setStatus(row.id, 'needs_review', 'manual_review');
      return;
    }

    const ref =`v-${row.id.slice(0, 8)}-${row.checkAttempts}-${Date.now().toString(36)}`;
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
    // gap #25 — the bank check compares the bank's name with the name typed in
    // the same form, so on its own it cannot tell a host from someone who took
    // over their account. A verified account that comes back under a
    // DIFFERENT legal name goes to a person.
    if (
      decision.status === 'verified' &&
      row.verifiedLegalName !== null &&
      normaliseName(row.verifiedLegalName) !== normaliseName(row.legalName)
    ) {
      await setStatus(row.id, 'needs_review', 'legal_name_changed');
      return;
    }
    await setStatus(row.id, decision.status, decision.status === 'verified' ? null : decision.reason);
  }

  const normaliseName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

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
    if (row.status !== 'suspended') throw illegalTransition(row.status, 'verified');
    return setStatus(id, 'verified', null, { reviewedBy: staff.userId });
  }

  // --- R5 — the publish gate -------------------------------------------------

  async function canPublishPaid(
    userId: string,
    organisationId: string | null = null,
  ): Promise<{ ok: boolean; missing: string[] }> {
    if (await deps.isStaff(userId)) return { ok: true, missing: [] };
    if (organisationId) {
      // org R6 — a verified organisation with its own verified account.
      const org = await db.organizerProfile.findUnique({
        where: { id: organisationId },
        select: { verification: true, isPersonal: true },
      });
      if (org && !org.isPersonal) {
        if (org.verification !== 'verified') return { ok: false, missing: [`organisation ${org.verification}`] };
        const account = await repo.accountByOrganisation(organisationId);
        if (!account) return { ok: false, missing: ['no organisation account'] };
        if (account.status !== 'verified') return { ok: false, missing: [account.status.replace('_', ' ')] };
        if ((await repo.openReceivables(account.id)) > 0n) return { ok: false, missing: ['money owed to PL4Y'] };
        return { ok: true, missing: [] };
      }
    }
    const row = await repo.accountByUser(userId);
    if (!row) return { ok: false, missing: ['no account'] };
    if (row.status !== 'verified') return { ok: false, missing: [row.status.replace('_', ' ')] };
    // gap #16 — a host who owes PL4Y money back (a refund after they were
    // paid) settles it before taking more money in.
    if ((await repo.openReceivables(row.id)) > 0n) return { ok: false, missing: ['money owed to PL4Y'] };
    return { ok: true, missing: [] };
  }

  // --- R8 — scheduling --------------------------------------------------------

  const rates = { commissionGstBps: deps.config.commissionGstBps, tdsBps: deps.config.tdsBps };

  async function quoteFor(payout: PayoutRow, conn: Db | Tx = db): Promise<PayoutQuote> {
    const rows = await repo.quoteRows(payout.eventId, conn);
    const open = await repo.openReceivables(payout.payoutAccountId, conn);
    // F27 — a host who cancels pays what the gateway kept on the refunds.
    const event = await conn.event.findUnique({ where: { id: payout.eventId }, select: { status: true } });
    return payoutQuote(rows, open, { ...rates, hostBearsGatewayFees: event?.status === 'cancelled' });
  }

  async function scheduleForEvent(eventId: string): Promise<PayoutView | null> {
    const event = await db.event.findUnique({ where: { id: eventId }, select: { organizerId: true, endsAt: true } });
    if (!event) return null;
    const rows = await repo.quoteRows(eventId);
    // A free event has nothing to settle; a fully refunded one settles to zero.
    if (!rows.some((r) => r.kind === 'charge')) return null;
    const account = await payeeAccountFor(eventId);
    if (!account) {
      // Paid publishing needs an account (R5), so this is staff-published
      // money with nobody to pay: a person decides.
      await deps.alert('Paid event with no payout account', `Event ${eventId} settled with no payout account for its host.`);
      return null;
    }
    // F3 — the first time a host is paid, players get a week to say the
    // event did not happen; after that, the usual 72 hours.
    const paidBefore = await db.payout.count({ where: { payoutAccountId: account.id, status: 'paid', amountPaise: { gt: 0n } } });
    const delay = paidBefore === 0 ? FIRST_PAYOUT_DELAY_MS : SETTLE_DELAY_MS;
    const row = await db.payout.upsert({
      where: { eventId_payoutAccountId: { eventId, payoutAccountId: account.id } },
      create: {
        id: newId(),
        eventId,
        payoutAccountId: account.id,
        dueAt: new Date(event.endsAt.getTime() + delay),
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
    // gap #25 — new bank details wait two days before money goes to them, so
    // a host whose account was taken over has time to notice the email.
    if (account.detailsChangedAt && now().getTime() - account.detailsChangedAt.getTime() < BANK_CHANGE_HOLD_MS) {
      return 'account_changed_recently';
    }
    if ((await repo.pendingRefundCount(payout.eventId, conn)) > 0) return 'refunds_pending';
    // gap #23 — a cancelled event owes its players everything. Until every
    // captured payment is refunded, nothing of it is the host's.
    const event = await conn.event.findUnique({
      where: { id: payout.eventId },
      select: { status: true, organizerProfileId: true },
    });
    if (event?.status === 'cancelled' && (await repo.unrefundedCaptureCount(payout.eventId, conn)) > 0) {
      return 'cancelled_event_unrefunded';
    }
    // org R7 — a suspended organisation's money waits until staff decide. A
    // staff release clears it like any review hold.
    if (event?.organizerProfileId && !payout.reviewClearedAt) {
      const org = await conn.organizerProfile.findUnique({
        where: { id: event.organizerProfileId },
        select: { verification: true },
      });
      if (org?.verification === 'suspended') return 'organisation_suspended';
    }
    // F3 — a player says it did not happen as promised, or nothing shows it
    // happened at all. PL4Y staff look before the money moves; their release
    // (`reviewClearedAt`) stands until a newer report arrives.
    if (deps.reviewSignals && event?.status !== 'cancelled') {
      const signals = await deps.reviewSignals(payout.eventId);
      const cleared = payout.reviewClearedAt;
      if (signals.openReports > 0 && (!cleared || (signals.latestReportAt && signals.latestReportAt > cleared))) {
        return 'player_report';
      }
      if (!cleared && signals.startedMatches === 0 && signals.checkIns === 0) return 'no_play_evidence';
    }
    return null;
  }

  async function sendPayout(payoutId: string): Promise<PayoutStatus> {
    // Phase 1, under the row lock: decide, freeze the quote, write the ledger,
    // move to `sending`. Only one caller can win this (payments R15).
    type Plan =
      | { kind: 'done'; status: PayoutStatus }
      | { kind: 'byHand'; amountPaise: bigint }
      | { kind: 'send'; payout: PayoutRow; quote: PayoutQuote };

    const byHand = provider.manual === true;
    const balance = byHand ? null : await provider.availablePaise().catch(() => null);

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
        gatewayFeesPaise: quote.gatewayFeesPaise,
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

      const attempt = payout.attempts + 1;
      const transferRef = attempt === 1 ? payout.id : `${payout.id}-r${attempt}`;

      if (byHand) {
        // Manual payouts — committed now, as if a transfer had been accepted:
        // the amount staff send is frozen and can no longer change under them.
        await tx.ledgerEntry.createMany({ data: payoutLedger(payout.id, quote, 1n) });
        await tx.payout.update({
          where: { id: payout.id },
          data: {
            ...frozen,
            status: 'sending',
            attempts: attempt,
            transferRef,
            providerStatus: BY_HAND,
            providerRef: null,
            sentAt: now(),
            lastError: null,
          },
        });
        return { kind: 'byHand', amountPaise: quote.amountPaise };
      }

      if (balance === null || balance < quote.amountPaise) {
        await tx.payout.update({ where: { id: payout.id }, data: { ...frozen, status: 'awaiting_funds' } });
        return { kind: 'done', status: 'awaiting_funds' as PayoutStatus };
      }

      await tx.ledgerEntry.createMany({ data: payoutLedger(payout.id, quote, 1n) });
      const sending = await tx.payout.update({
        where: { id: payout.id },
        data: { ...frozen, status: 'sending', attempts: attempt, transferRef, sentAt: now(), lastError: null },
      });
      return { kind: 'send', payout: sending, quote };
    });

    if (plan.kind === 'byHand') {
      await deps.alert(
        'Host payout ready to pay',
        `Payout ${payoutId} (₹${(Number(plan.amountPaise) / 100).toFixed(2)}) is ready. ` +
          'Send it from the bank, then mark it paid with the UTR in the admin portal (Payouts).',
      );
      return 'sending';
    }

    if (plan.kind === 'done') {
      if (plan.status === 'awaiting_funds') {
        await deps.alert('Top up the RazorpayX payouts account', `Payout ${payoutId} is waiting for funds.`);
      }
      return plan.status;
    }

    // Phase 2, outside any transaction: talk to the provider.
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
      // Unknown outcome: the provider may have taken it. Stay `sending`; the status
      // check decides, and the transferRef stops a second send (R11).
      if (!(err instanceof GatewayError)) throw err;
      logger.warn({ err, payoutId }, 'payout transfer outcome unknown; checking later');
    }
    await deps.jobs.checkPayout(plan.payout.id, 5 * 60_000);
    return 'sending';
  }

  /**
   * Undoes what committing a payout wrote, once it is known no money went: its
   * ledger rows, and the receivables refunds wrote against it meanwhile (R15).
   * Those refunds are in the payout's next quote, so leaving the receivables
   * would take them off the host twice.
   */
  async function reverseCommitted(tx: Tx, row: PayoutRow): Promise<void> {
    await tx.ledgerEntry.createMany({ data: payoutLedger(row.id, row, -1n) });
    const owed = await tx.ledgerEntry.groupBy({
      by: ['refundId', 'registrationId'],
      where: { payoutId: row.id, kind: 'host_receivable', refundId: { not: null } },
      _sum: { amountPaise: true },
    });
    const reversals = owed
      .filter((r) => (r._sum.amountPaise ?? 0n) > 0n)
      .map((r) => ({
        payoutId: row.id,
        refundId: r.refundId,
        registrationId: r.registrationId,
        kind: 'host_receivable',
        amountPaise: -(r._sum.amountPaise ?? 0n),
      }));
    if (reversals.length > 0) await tx.ledgerEntry.createMany({ data: reversals });
  }

  async function failPayout(payoutId: string, error: string, reversed: boolean): Promise<void> {
    const payout = await db.$transaction(async (tx) => {
      const row = await repo.lockPayout(tx, payoutId);
      if (!row || row.status !== 'sending') return null;
      await reverseCommitted(tx, row);
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
    // Manual payouts — no provider knows about it; staff mark it paid.
    if (payout.providerStatus === BY_HAND) return 'sending';
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

  /**
   * The host already has this entry's money, so what the refund took from it
   * is owed back. Measured as the per-entry quote before and after the refund,
   * so it follows R9 exactly: a withdrawal refunds fee + tax but the host only
   * ever had the fee, less the commission already taken on it.
   */
  async function onRefundProcessed(refundId: string): Promise<void> {
    const refundRows = await repo.refundLedger(refundId);
    const registrationId = refundRows[0]?.registrationId;
    if (!registrationId) return;
    const reg = await db.registration.findUnique({
      where: { id: registrationId },
      select: { eventId: true, eventCategory: { select: { commissionBps: true } } },
    });
    if (!reg) return;
    const payout = await repo.payoutForEvent(reg.eventId);
    // Not yet sent: the refund is simply in the quote when it is.
    if (!payout || !['sending', 'paid'].includes(payout.status)) return;
    // A redelivered refund.processed must not owe twice.
    if (await db.ledgerEntry.findFirst({ where: { refundId, kind: 'host_receivable' } })) return;

    const entry = await db.ledgerEntry.findMany({ where: { registrationId, kind: { in: ENTRY_KINDS } } });
    const toQuote = (rows: typeof entry) =>
      payoutQuote(
        rows.map((r) => ({ registrationId, kind: r.kind, amountPaise: r.amountPaise, commissionBps: reg.eventCategory.commissionBps })),
        0n,
        { commissionGstBps: 0, tdsBps: 0 },
      ).amountPaise;
    const owed = toQuote(entry.filter((r) => r.refundId !== refundId)) - toQuote(entry);
    if (owed <= 0n) return;
    await db.ledgerEntry.create({
      data: { payoutId: payout.id, refundId, registrationId, kind: 'host_receivable', amountPaise: owed },
    });
  }

  // --- R10, R13 — staff ---------------------------------------------------------

  async function holdPayout(staff: Staff, id: string, reason: string): Promise<PayoutView> {
    requireDecider(staff);
    // Manual payouts — "Ready to pay" means nobody has sent it yet, so it can
    // still be stopped. What committing it wrote is undone; a release quotes
    // it afresh, refunds included.
    const unreadied = await db.$transaction(async (tx) => {
      const row = await repo.lockPayout(tx, id);
      if (row?.status !== 'sending' || row.providerStatus !== BY_HAND) return false;
      await reverseCommitted(tx, row);
      await tx.payout.update({
        where: { id },
        data: { status: 'held', holdReason: `${STAFF_HOLD}${reason.trim()}`, providerStatus: null, sentAt: null },
      });
      return true;
    });
    if (unreadied) return toPayoutView((await repo.payoutById(id))!);

    const updated = await db.payout.updateMany({
      where: { id, status: { in: SENDABLE } },
      data: { status: 'held', holdReason: `${STAFF_HOLD}${reason.trim()}` },
    });
    if (updated.count === 0) throw new UserError(PayoutCode.PAYOUT_NOT_HELD, 'Only a payout that has not been sent can be held.');
    return toPayoutView((await repo.payoutById(id))!);
  }

  async function releasePayout(staff: Staff, id: string): Promise<PayoutView> {
    requireDecider(staff);
    // F3 — a person looked: review holds (reports, no sign of play) stay
    // lifted unless a report arrives after this.
    const updated = await db.payout.updateMany({
      where: { id, status: 'held' },
      data: { status: 'scheduled', holdReason: null, reviewClearedAt: now() },
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

  // --- Manual payouts ---------------------------------------------------------

  /**
   * Staff sent a "Ready to pay" payout from PL4Y's bank. The UTR is the proof,
   * and `amountPaise` is what they say they sent: it has to be the frozen
   * amount, so a typo never records a payment that did not happen. The host
   * is told, with the UTR to find it in their statement.
   */
  async function markPaid(staff: Staff, id: string, input: { utr: string; amountPaise: bigint }): Promise<PayoutView> {
    requireDecider(staff);
    const utr = input.utr.replace(/[\s-]/g, '').toUpperCase();
    if (!UTR_PATTERN.test(utr)) {
      throw new UserError(PayoutCode.INVALID_UTR, 'Enter the UTR or UPI reference from your bank: 6 to 35 letters and digits.');
    }
    const used = await repo.payoutByUtr(utr);
    if (used && used.id !== id) {
      throw new UserError(PayoutCode.UTR_ALREADY_USED, 'That UTR is already recorded on another payout. Check the reference.');
    }

    const paid = await db.$transaction(async (tx) => {
      const row = await repo.lockPayout(tx, id);
      if (row?.status !== 'sending' || row.providerStatus !== BY_HAND) {
        throw new UserError(PayoutCode.PAYOUT_NOT_READY, 'Only a payout in "Ready to pay" can be marked paid.');
      }
      if (input.amountPaise !== row.amountPaise) {
        throw new UserError(
          PayoutCode.PAYOUT_AMOUNT_MISMATCH,
          `This payout is ₹${(Number(row.amountPaise) / 100).toFixed(2)}. Record it only once you have sent exactly that.`,
          { details: { expectedPaise: Number(row.amountPaise) } },
        );
      }
      return tx.payout.update({ where: { id }, data: { status: 'paid', paidAt: now(), providerRef: utr, lastError: null } });
    });

    const account = await repo.accountById(paid.payoutAccountId);
    const event = await db.event.findUnique({ where: { id: paid.eventId }, select: { title: true } });
    if (account) {
      await deps.notify(account.userId, 'payout.status', {
        eventTitle: event?.title ?? '',
        state: 'paid',
        amountPaise: paid.amountPaise.toString(),
        utr,
      });
    }
    return toPayoutView(paid);
  }

  /** Manual payouts — the "Ready to pay" list, oldest first. Masked; any staff member reads it, deciders pay. */
  async function payoutsToPay(_staff: Staff): Promise<PayoutView[]> {
    return (await repo.toPayByHand()).map((r) => toPayoutView(r));
  }

  /**
   * Manual payouts — the clear account number, for checking it with the host
   * or sending the money. Admin and finance only; the caller audits every look.
   */
  async function accountDetails(staff: Staff, id: string): Promise<PayoutAccountDetails> {
    requireDecider(staff);
    const row = await accountOrThrow(id);
    return {
      id: row.id,
      legalName: row.legalName,
      accountNumber: box.open(row.accountCipher),
      ifsc: row.ifsc,
      status: row.status as AccountStatus,
      detailsChangedAt: row.detailsChangedAt,
    };
  }

  /**
   * gap #16 — a host who owes PL4Y (a refund after they were paid) paid it back
   * by bank transfer, so they can take paid entries again. Written as a
   * recovery against their latest payout, the same row a later payout would
   * write when it nets the debt. Part payments are fine; more than is owed is not.
   */
  async function recordRepayment(
    staff: Staff,
    payoutAccountId: string,
    input: { amountPaise: bigint; utr: string },
  ): Promise<{ openPaise: bigint }> {
    requireDecider(staff);
    const utr = input.utr.replace(/[\s-]/g, '').toUpperCase();
    if (!UTR_PATTERN.test(utr)) {
      throw new UserError(PayoutCode.INVALID_UTR, 'Enter the UTR or UPI reference of their payment: 6 to 35 letters and digits.');
    }
    return db.$transaction(async (tx) => {
      // One recorder at a time per account, so two people cannot both take the same debt off.
      await tx.$queryRaw`SELECT id FROM payout_accounts WHERE id = ${payoutAccountId}::uuid FOR UPDATE`;
      const open = await repo.openReceivables(payoutAccountId, tx);
      if (open <= 0n) throw new UserError(PayoutCode.NOTHING_OWED, 'This host owes PL4Y nothing.');
      if (input.amountPaise <= 0n || input.amountPaise > open) {
        throw new UserError(
          PayoutCode.REPAYMENT_TOO_LARGE,
          `They owe ₹${(Number(open) / 100).toFixed(2)}. Record what they paid, up to that.`,
          { details: { openPaise: Number(open) } },
        );
      }
      const latest = await tx.payout.findFirst({ where: { payoutAccountId }, orderBy: { createdAt: 'desc' } });
      // Every receivable sits on a payout, so an account that owes has one.
      if (!latest) throw new SystemError(SharedCode.NOT_FOUND, 'No payout to record the repayment against');
      await tx.ledgerEntry.create({ data: { payoutId: latest.id, kind: 'receivable_recovered', amountPaise: -input.amountPaise } });
      return { openPaise: open - input.amountPaise };
    });
  }

  /** The masked account a payout goes to — the portal's "Ready to pay" rows. */
  async function accountForPayout(payoutAccountId: string): Promise<PayoutAccountView | null> {
    const row = await repo.accountById(payoutAccountId);
    return row ? toView(row) : null;
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

  /** org R6 — an organisation's payouts, newest first. The caller checked the viewer may see money. */
  async function organisationPayouts(organizerProfileId: string, first = 20): Promise<PayoutView[]> {
    const account = await repo.accountByOrganisation(organizerProfileId);
    if (!account) return [];
    const rows = await repo.payoutsForAccount(account.id, first, null);
    return rows.slice(0, first).map((r) => toPayoutView(r));
  }

  /** Any staff member reads the list (the portal shows it to support); only deciders act on it. */
  async function payoutsNeedingAttention(_staff: Staff): Promise<PayoutView[]> {
    // A held payout has never been sent, so its stored amounts are still zero: show the live quote.
    return Promise.all(
      (await repo.heldOrFailed()).map(async (r) => (SENDABLE.includes(r.status) ? toPayoutView(r, await quoteFor(r)) : toPayoutView(r))),
    );
  }

  /** gap #16 — who owes PL4Y and how much. Any staff member reads it (the portal's Payouts page); deciders record repayments. */
  async function openReceivables(_staff: Staff): Promise<{ payoutAccountId: string; userId: string; openPaise: bigint }[]> {
    const rows = await db.$queryRaw<{ payout_account_id: string; user_id: string; open: bigint }[]>`
      SELECT p.payout_account_id, pa.user_id, SUM(le.amount_paise)::bigint AS open
        FROM ledger_entries le
        JOIN payouts p ON p.id = le.payout_id
        JOIN payout_accounts pa ON pa.id = p.payout_account_id
       WHERE le.kind IN ('host_receivable', 'receivable_recovered')
       GROUP BY p.payout_account_id, pa.user_id
      HAVING SUM(le.amount_paise) > 0`;
    return rows.map((r) => ({ payoutAccountId: r.payout_account_id, userId: r.user_id, openPaise: r.open }));
  }

  return {
    saveAccount,
    myAccount,
    organisationAccount,
    organisationPayouts,
    setOrganisationAccountHolder,
    verifyAccount,
    accountsForReview,
    approveAccount,
    rejectAccount,
    suspendAccount,
    reinstateAccount,
    canPublishPaid,
    scheduleForEvent,
    settleDue,
    sendPayout,
    checkPayout,
    checkByRef,
    sweepSending,
    onRefundProcessed,
    holdPayout,
    releasePayout,
    retryPayout,
    markPaid,
    payoutsToPay,
    recordRepayment,
    accountDetails,
    accountForPayout,
    payoutForEvent,
    myPayouts,
    payoutsNeedingAttention,
    openReceivables,
  };
}

export type PayoutsService = ReturnType<typeof createPayoutsService>;

/**
 * payouts R16 — identity R18's deletion guard. A host who is still owed money,
 * or who owes some back, cannot vanish.
 */
export function payoutsDeletionGuard(db: Db) {
  return async (userId: string): Promise<string[]> => {
    const account = await db.payoutAccount.findFirst({ where: { userId, organizerProfileId: null }, select: { id: true } });
    if (!account) return [];
    const blockers: string[] = [];
    const owed = await db.payout.count({
      where: { payoutAccountId: account.id, status: { in: ['scheduled', 'held', 'awaiting_funds', 'sending', 'failed'] } },
    });
    if (owed > 0) blockers.push('PAYOUT_OWED');
    const [row] = await db.$queryRaw<{ open: bigint | null }[]>`
      SELECT SUM(le.amount_paise)::bigint AS open
        FROM ledger_entries le JOIN payouts p ON p.id = le.payout_id
       WHERE p.payout_account_id = ${account.id}::uuid
         AND le.kind IN ('host_receivable', 'receivable_recovered')`;
    if ((row?.open ?? 0n) > 0n) blockers.push('OPEN_HOST_RECEIVABLE');
    return blockers;
  };
}
