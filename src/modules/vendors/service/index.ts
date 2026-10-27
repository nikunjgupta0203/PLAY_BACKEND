/**
 * vendors — the PL4Y Shop vendor partnership form and its review in the portal
 * (docs/modules/23-vendors.md).
 *
 * R1 Anyone with the link applies, without an account: seller, products,
 *    fulfilment, then one consent. No bank details or identity documents.
 * R2 Answers are checked against form.ts (the same checker as partnerships).
 *    A store name is required except for an individual; the highest price is
 *    not below the lowest; a GSTIN, when given, has the GSTIN shape.
 * R3 Submitting the same attempt (client token) twice returns the first one.
 * R4 The seller gets a confirmation email and the team a heads-up; both are
 *    best effort and never lose the application.
 * R5 Throttled per IP and per email; a filled hidden field gets a fake receipt.
 * R6 Staff move an application through NEW → REVIEWING → MORE_INFO_NEEDED →
 *    APPROVED / REJECTED, every move recorded with who made it, and keep notes
 *    the seller never sees.
 */
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
// The pure answer checker partnerships owns; its index would also start that module's mail and media.
import { AnswerCode, check, type Answers } from '../../partnerships/service/answers.js';
import { FULFILMENT, PRODUCTS, SELLER, SELLER_TYPES, type SellerType, type Sport } from './form.js';

export const VendorCode = {
  /** R3 — the form's attempt id is missing or not a UUID. Reload the form. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** R1 — the consent on the review step. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** R5 — too many applications from one place. */
  VENDOR_THROTTLED: 'VENDOR_THROTTLED',
  VENDOR_NOT_FOUND: 'VENDOR_NOT_FOUND',
  INVALID_STATUS: 'INVALID_STATUS',
  INVALID_NOTE: 'INVALID_NOTE',
} as const;

/** R6 — in the order an application usually moves through them. */
export const VENDOR_STATUSES = ['new', 'reviewing', 'more_info_needed', 'approved', 'rejected'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/** R5 — per IP and per email. A real seller sends one or two. */
export const SUBMIT_WINDOWS = {
  perIpHour: { seconds: 3600, max: 10 },
  perIpDay: { seconds: 86_400, max: 30 },
  perEmailDay: { seconds: 86_400, max: 5 },
} satisfies Record<string, Window>;

const NOTE_MAX = 4000;
const PAGE_MAX = 100;
const EXPORT_MAX = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 15 characters: state code, PAN, entity number, Z, check character. */
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** No 0/O, 1/I/L: a reference is read out over the phone. */
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface VendorApplication {
  id: string;
  reference: string;
  sellerType: SellerType;
  storeName: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  city: string;
  sports: Sport[];
  gstStatus: string;
  commercialModel: string;
  seller: Answers;
  products: Answers;
  fulfilment: Answers;
  consentedAt: Date;
  status: VendorStatus;
  confirmationEmail: 'pending' | 'sent' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

/** What the seller is shown once it is sent: nothing they did not type themselves. */
export interface Receipt {
  reference: string;
  storeName: string;
  submittedAt: Date;
}

export interface SubmitInput {
  clientToken: string;
  seller: Record<string, unknown>;
  products: Record<string, unknown>;
  fulfilment: Record<string, unknown>;
  consent: boolean;
  /** R5 — a field people never see. Anything in it means a bot filled the form. */
  trap?: string | null;
}

export interface VendorNote {
  id: string;
  applicationId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface StatusChange {
  id: string;
  fromStatus: VendorStatus | null;
  toStatus: VendorStatus;
  byUserId: string | null;
  createdAt: Date;
}

export interface Filter {
  /** Store, contact name, email, phone or reference. */
  search?: string | null;
  status?: VendorStatus | null;
  sport?: Sport | null;
  city?: string | null;
}

export interface VendorDeps {
  db: Db;
  limiter: { consumeAll(checks: { key: string; window: Window }[]): Promise<LimitResult> };
  /** R4 — both best effort: a failure is logged, never thrown. */
  mail: {
    confirmation(application: VendorApplication): Promise<boolean>;
    team(application: VendorApplication): Promise<void>;
  };
  now?: () => Date;
}

type Row = Prisma.VendorApplicationGetPayload<object>;

const toView = (r: Row): VendorApplication => ({
  id: r.id,
  reference: r.reference,
  sellerType: r.sellerType as SellerType,
  storeName: r.storeName,
  contactName: r.contactName,
  contactEmail: r.contactEmail,
  contactPhone: r.contactPhone,
  city: r.city,
  sports: r.sports as Sport[],
  gstStatus: r.gstStatus,
  commercialModel: r.commercialModel,
  seller: r.seller as Answers,
  products: r.products as Answers,
  fulfilment: r.fulfilment as Answers,
  consentedAt: r.consentedAt,
  status: r.status as VendorStatus,
  confirmationEmail: r.confirmationEmail as VendorApplication['confirmationEmail'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** The name an application goes by: the store's, or the person's for an individual. */
export const displayName = (a: Pick<VendorApplication, 'storeName' | 'contactName'>): string => a.storeName ?? a.contactName;

const receipt = (a: VendorApplication): Receipt => ({ reference: a.reference, storeName: displayName(a), submittedAt: a.createdAt });

function reference(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `SHOP-${s}`;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const refuse = (code: string, field: string, message: string) => new UserError(code, message, { details: { field } });

/** R2 — everything the seller sent, checked, in the shape it is stored in. */
export function checked(input: Pick<SubmitInput, 'seller' | 'products' | 'fulfilment' | 'consent'>) {
  // No uploads on this form, so no image folder to hold answers to.
  const seller = check(SELLER, asObject(input.seller), ['seller'], '');
  const sellerType = seller.sellerType as SellerType;
  if (!SELLER_TYPES.includes(sellerType)) throw refuse(AnswerCode.ANSWER_REQUIRED, 'seller.sellerType', 'Seller type is required.');
  const storeName = typeof seller.storeName === 'string' ? seller.storeName : null;
  if (!storeName && sellerType !== 'individual') {
    throw refuse(AnswerCode.ANSWER_REQUIRED, 'seller.storeName', 'Store / brand name is required.');
  }

  const products = check(PRODUCTS, asObject(input.products), ['products'], '');
  if ((products.priceMax as number) < (products.priceMin as number)) {
    throw refuse(AnswerCode.INVALID_ANSWER, 'products.priceMax', 'The highest price can’t be below the lowest.');
  }

  const fulfilment = check(FULFILMENT, asObject(input.fulfilment), ['fulfilment'], '');
  if (typeof fulfilment.gstin === 'string') {
    const gstin = fulfilment.gstin.replace(/\s+/g, '').toUpperCase();
    if (!GSTIN.test(gstin)) throw refuse(AnswerCode.INVALID_ANSWER, 'fulfilment.gstin', 'Enter a 15-character GSTIN, like 22AAAAA0000A1Z5.');
    fulfilment.gstin = gstin;
  }

  if (!input.consent) throw refuse(VendorCode.CONSENT_REQUIRED, 'consent', 'Tick the confirmation above the submit button.');
  return { seller, sellerType, storeName, products, fulfilment };
}

export function createVendorService(deps: VendorDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function token(raw: string): string {
    if (!UUID.test(raw)) throw new UserError(VendorCode.INVALID_TOKEN, 'This form needs reloading. Your answers are kept on this device.');
    return raw.toLowerCase();
  }

  async function byToken(clientToken: string): Promise<VendorApplication | null> {
    const row = await db.vendorApplication.findUnique({ where: { clientToken } });
    return row ? toView(row) : null;
  }

  /** R1–R5 — stores the application, then sends the two emails. */
  async function submit(input: SubmitInput, from: { ip: string }): Promise<Receipt> {
    const clientToken = token(input.clientToken);
    const earlier = await byToken(clientToken);
    if (earlier) return receipt(earlier);

    const f = checked(input);
    const email = f.seller.email as string;

    // R5 — a bot is shown what a person would be, and nothing is stored.
    if (input.trap?.trim()) {
      return { reference: reference(), storeName: f.storeName ?? (f.seller.contactName as string), submittedAt: now() };
    }
    const limit = await deps.limiter.consumeAll([
      { key: `vendor:ip:h:${from.ip}`, window: SUBMIT_WINDOWS.perIpHour },
      { key: `vendor:ip:d:${from.ip}`, window: SUBMIT_WINDOWS.perIpDay },
      { key: `vendor:email:${email}`, window: SUBMIT_WINDOWS.perEmailDay },
    ]);
    if (!limit.allowed) {
      throw new UserError(VendorCode.VENDOR_THROTTLED, 'Too many attempts from here. Try again a little later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    let created: VendorApplication | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const id = newId();
      try {
        const row = await db.$transaction(async (tx) => {
          const r = await tx.vendorApplication.create({
            data: {
              id,
              reference: reference(),
              clientToken,
              sellerType: f.sellerType,
              storeName: f.storeName,
              contactName: f.seller.contactName as string,
              contactEmail: email,
              contactPhone: f.seller.whatsapp as string,
              city: f.seller.city as string,
              sports: f.products.sports as string[],
              gstStatus: f.fulfilment.gstStatus as string,
              commercialModel: f.fulfilment.commercialModel as string,
              seller: f.seller as Prisma.InputJsonValue,
              products: f.products as Prisma.InputJsonValue,
              fulfilment: f.fulfilment as Prisma.InputJsonValue,
              consentedAt: now(),
            },
          });
          await tx.vendorStatusChange.create({ data: { id: newId(), applicationId: id, fromStatus: null, toStatus: 'new', byUserId: null } });
          return r;
        });
        created = toView(row);
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        // R3 — the same attempt, submitted twice at once: the first one won.
        const twin = await byToken(clientToken);
        if (twin) return receipt(twin);
        // Otherwise the reference was taken: draw another.
      }
    }
    if (!created) throw new Error('vendors: no free reference after 5 tries');

    // R4 — the application is stored; an email that fails says so in the portal and nothing more.
    const sent = await deps.mail.confirmation(created);
    await db.vendorApplication.update({ where: { id: created.id }, data: { confirmationEmail: sent ? 'sent' : 'failed' } });
    await deps.mail.team(created);
    return receipt(created);
  }

  // --- the portal ---------------------------------------------------------------------------

  function where(f: Filter): Prisma.VendorApplicationWhereInput {
    const q = f.search?.trim();
    const city = f.city?.trim();
    return {
      ...(f.status ? { status: f.status } : {}),
      ...(f.sport ? { sports: { has: f.sport } } : {}),
      ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
      ...(q
        ? {
            OR: [
              { storeName: { contains: q, mode: 'insensitive' } },
              { contactName: { contains: q, mode: 'insensitive' } },
              { contactEmail: { contains: q, mode: 'insensitive' } },
              { contactPhone: { contains: q } },
              { reference: { contains: q.toUpperCase() } },
            ],
          }
        : {}),
    };
  }

  /** R6 — newest first. */
  async function list(f: Filter, page: { limit: number; offset: number }): Promise<{ total: number; items: VendorApplication[] }> {
    const w = where(f);
    const [total, rows] = await Promise.all([
      db.vendorApplication.count({ where: w }),
      db.vendorApplication.findMany({
        where: w,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(page.limit, 1), PAGE_MAX),
        skip: Math.max(page.offset, 0),
      }),
    ]);
    return { total, items: rows.map(toView) };
  }

  async function exportRows(f: Filter): Promise<VendorApplication[]> {
    const rows = await db.vendorApplication.findMany({ where: where(f), orderBy: { createdAt: 'desc' }, take: EXPORT_MAX });
    return rows.map(toView);
  }

  async function byId(id: string): Promise<VendorApplication | null> {
    if (!UUID.test(id)) return null;
    const row = await db.vendorApplication.findUnique({ where: { id } });
    return row ? toView(row) : null;
  }

  async function found(id: string): Promise<VendorApplication> {
    const a = await byId(id);
    if (!a) throw new UserError(VendorCode.VENDOR_NOT_FOUND, 'That application could not be found.');
    return a;
  }

  async function cities(): Promise<string[]> {
    const rows = await db.vendorApplication.findMany({ distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } });
    return rows.map((r) => r.city);
  }

  async function counts(): Promise<Record<VendorStatus, number>> {
    const rows = await db.vendorApplication.groupBy({ by: ['status'], _count: { _all: true } });
    const out = Object.fromEntries(VENDOR_STATUSES.map((s) => [s, 0])) as Record<VendorStatus, number>;
    for (const r of rows) out[r.status as VendorStatus] = r._count._all;
    return out;
  }

  async function notes(applicationId: string): Promise<VendorNote[]> {
    return db.vendorNote.findMany({ where: { applicationId }, orderBy: { createdAt: 'desc' } });
  }

  async function history(applicationId: string): Promise<StatusChange[]> {
    const rows = await db.vendorStatusChange.findMany({ where: { applicationId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.fromStatus as VendorStatus | null,
      toStatus: r.toStatus as VendorStatus,
      byUserId: r.byUserId,
      createdAt: r.createdAt,
    }));
  }

  /** R6 — moves the application on, and records who did. The same status again changes nothing. */
  async function setStatus(staff: { userId: string }, id: string, status: VendorStatus): Promise<VendorApplication> {
    if (!VENDOR_STATUSES.includes(status)) throw new UserError(VendorCode.INVALID_STATUS, 'That is not a status.');
    const before = await found(id);
    if (before.status === status) return before;
    const row = await db.$transaction(async (tx) => {
      const r = await tx.vendorApplication.update({ where: { id }, data: { status } });
      await tx.vendorStatusChange.create({
        data: { id: newId(), applicationId: id, fromStatus: before.status, toStatus: status, byUserId: staff.userId },
      });
      return r;
    });
    return toView(row);
  }

  /** R6 — a note for staff. The seller never sees it. */
  async function addNote(staff: { userId: string }, id: string, body: string): Promise<VendorNote> {
    await found(id);
    const text = body.trim();
    if (text.length === 0 || text.length > NOTE_MAX) {
      throw new UserError(VendorCode.INVALID_NOTE, `Write a note of up to ${NOTE_MAX.toLocaleString('en-IN')} characters.`);
    }
    return db.vendorNote.create({ data: { id: newId(), applicationId: id, authorId: staff.userId, body: text } });
  }

  return { submit, list, exportRows, byId, cities, counts, notes, history, setStatus, addNote };
}

export type VendorService = ReturnType<typeof createVendorService>;
