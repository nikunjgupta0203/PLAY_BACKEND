/**
 * partnerships — the shareable partnership form and its review in the portal
 * (docs/modules/22-partnerships.md).
 *
 * Anyone with the link applies, without an account. One application holds the
 * shared details once and a section for every category they picked (R1); the
 * answers are checked against form.ts (R2). PL4Y staff work through the
 * applications in the portal: status, notes, verification, an owner, a
 * follow-up date, and a link to an earlier application from the same
 * organisation (R6, R7).
 */
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import type { UploadSignature } from '../../../platform/cloudinary.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
import { check, images, type Answers } from './answers.js';
import { APPLICANT_TYPES, BASIC, CATEGORIES, SECTIONS, type ApplicantType, type Category } from './form.js';

export const PartnershipCode = {
  /** R3 — the form's attempt id is missing or not a UUID. Reload the form. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** R1 — at least one category, each one PL4Y offers. */
  INVALID_CATEGORIES: 'INVALID_CATEGORIES',
  /** R2 — the two required confirmations on the review step. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** R5 — too many applications or uploads from one place. */
  PARTNERSHIP_THROTTLED: 'PARTNERSHIP_THROTTLED',
  PARTNERSHIP_NOT_FOUND: 'PARTNERSHIP_NOT_FOUND',
  INVALID_STATUS: 'INVALID_STATUS',
  INVALID_NOTE: 'INVALID_NOTE',
  /** R6 — an application is assigned to PL4Y staff only. */
  INVALID_ASSIGNEE: 'INVALID_ASSIGNEE',
  /** R7 — linked to another, existing application, never itself. */
  INVALID_LINK: 'INVALID_LINK',
} as const;

/** R6 — in the order an application usually moves through them. */
export const PARTNERSHIP_STATUSES = [
  'submitted',
  'under_review',
  'contacted',
  'in_discussion',
  'confirmed',
  'launch_ready',
  'active',
  'on_hold',
  'closed',
] as const;
export type PartnershipStatus = (typeof PARTNERSHIP_STATUSES)[number];

/** R5 — per IP and per email. A real organisation sends one or two. */
export const SUBMIT_WINDOWS = {
  perIpHour: { seconds: 3600, max: 10 },
  perIpDay: { seconds: 86_400, max: 30 },
  perEmailDay: { seconds: 86_400, max: 5 },
} satisfies Record<string, Window>;
/** R5 — a venue with many locations uploads many photos. */
export const UPLOAD_WINDOW: Window = { seconds: 3600, max: 120 };

const NOTE_MAX = 4000;
const PAGE_MAX = 100;
const EXPORT_MAX = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No 0/O, 1/I/L: a reference is read out over the phone. */
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface PartnershipApplication {
  id: string;
  reference: string;
  applicantType: ApplicantType;
  organisationName: string | null;
  city: string;
  state: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  categories: Category[];
  profile: Answers;
  sections: Partial<Record<Category, Answers>>;
  consentAccurate: boolean;
  consentContact: boolean;
  consentPublish: boolean;
  consentedAt: Date;
  status: PartnershipStatus;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  assignedTo: string | null;
  /** `YYYY-MM-DD`. */
  followUpOn: string | null;
  linkedApplicationId: string | null;
  confirmationEmail: 'pending' | 'sent' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

/** What the applicant is shown once it is sent: nothing they did not type themselves. */
export interface Receipt {
  reference: string;
  organisationName: string;
  categories: Category[];
  submittedAt: Date;
}

export interface SubmitInput {
  clientToken: string;
  profile: Record<string, unknown>;
  categories: string[];
  sections: Record<string, unknown>;
  consentAccurate: boolean;
  consentContact: boolean;
  consentPublish: boolean;
  /** R5 — a field people never see. Anything in it means a bot filled the form. */
  trap?: string | null;
}

export interface PartnershipNote {
  id: string;
  applicationId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface StatusChange {
  id: string;
  fromStatus: PartnershipStatus | null;
  toStatus: PartnershipStatus;
  byUserId: string | null;
  createdAt: Date;
}

export interface Filter {
  /** Organisation, contact name, email, phone or reference. */
  search?: string | null;
  category?: Category | null;
  city?: string | null;
  status?: PartnershipStatus | null;
}

export interface PartnershipDeps {
  db: Db;
  limiter: { consumeAll(checks: { key: string; window: Window }[]): Promise<LimitResult> };
  media: {
    signUpload(opts: { publicId: string; folder: string }): UploadSignature;
    /** The folder one attempt's uploads go to. */
    root(clientToken: string): string;
  };
  /** R4 — both best effort: a failure is logged, never thrown, and never loses the application. */
  mail: {
    confirmation(application: PartnershipApplication): Promise<boolean>;
    team(application: PartnershipApplication): Promise<void>;
  };
  now?: () => Date;
}

type Row = Prisma.PartnershipApplicationGetPayload<object>;

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const toView = (r: Row): PartnershipApplication => ({
  id: r.id,
  reference: r.reference,
  applicantType: r.applicantType as ApplicantType,
  organisationName: r.organisationName,
  city: r.city,
  state: r.state,
  contactName: r.contactName,
  contactEmail: r.contactEmail,
  contactPhone: r.contactPhone,
  categories: r.categories as Category[],
  profile: r.profile as Answers,
  sections: r.sections as Partial<Record<Category, Answers>>,
  consentAccurate: r.consentAccurate,
  consentContact: r.consentContact,
  consentPublish: r.consentPublish,
  consentedAt: r.consentedAt,
  status: r.status as PartnershipStatus,
  verifiedAt: r.verifiedAt,
  verifiedBy: r.verifiedBy,
  assignedTo: r.assignedTo,
  followUpOn: day(r.followUpOn),
  linkedApplicationId: r.linkedApplicationId,
  confirmationEmail: r.confirmationEmail as PartnershipApplication['confirmationEmail'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** The name an application goes by: the organisation's, or the person's for an individual. */
export const displayName = (a: Pick<PartnershipApplication, 'organisationName' | 'contactName'>): string =>
  a.organisationName ?? a.contactName;

const receipt = (a: PartnershipApplication): Receipt => ({
  reference: a.reference,
  organisationName: displayName(a),
  categories: a.categories,
  submittedAt: a.createdAt,
});

function reference(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `P4Y-${s}`;
}

export function createPartnershipService(deps: PartnershipDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function token(raw: string): string {
    if (!UUID.test(raw)) {
      throw new UserError(PartnershipCode.INVALID_TOKEN, 'This form needs reloading. Your answers are kept on this device.');
    }
    return raw.toLowerCase();
  }

  async function throttle(checks: { key: string; window: Window }[]): Promise<void> {
    const limit = await deps.limiter.consumeAll(checks);
    if (!limit.allowed) {
      throw new UserError(PartnershipCode.PARTNERSHIP_THROTTLED, 'Too many attempts from here. Try again a little later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
  }

  /** R1, R2 — everything the applicant sent, checked, in the shape it is stored in. */
  function checked(clientToken: string, input: SubmitInput) {
    const root = deps.media.root(clientToken);
    const profile = check(BASIC, input.profile ?? {}, ['basic'], root);
    const applicantType = profile.applicantType as ApplicantType;
    if (!APPLICANT_TYPES.includes(applicantType)) {
      throw new UserError('ANSWER_REQUIRED', 'Applicant type is required.', { details: { field: 'basic.applicantType' } });
    }
    const organisationName = typeof profile.organisationName === 'string' ? profile.organisationName : null;
    if (!organisationName && applicantType !== 'individual') {
      throw new UserError('ANSWER_REQUIRED', 'Organisation name is required.', { details: { field: 'basic.organisationName' } });
    }

    const categories = CATEGORIES.filter((c) => input.categories.includes(c));
    if (categories.length === 0 || input.categories.some((c) => !(CATEGORIES as readonly string[]).includes(c))) {
      throw new UserError(PartnershipCode.INVALID_CATEGORIES, 'Pick at least one way to partner with PL4Y.', {
        details: { field: 'categories' },
      });
    }
    // Only the sections picked: answers kept on the device for a category since dropped are not sent on.
    const sections: Partial<Record<Category, Answers>> = {};
    for (const c of categories) {
      const raw = input.sections?.[c];
      sections[c] = check(SECTIONS[c], raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}, [c], root);
    }

    if (!input.consentAccurate || !input.consentContact) {
      throw new UserError(PartnershipCode.CONSENT_REQUIRED, 'Confirm the two statements above the submit button.', {
        details: { field: 'consent' },
      });
    }

    const uploaded = [...images(BASIC, profile), ...categories.flatMap((c) => images(SECTIONS[c], sections[c]!))];
    return { profile, applicantType, organisationName, categories, sections, uploaded };
  }

  async function byToken(clientToken: string): Promise<PartnershipApplication | null> {
    const row = await db.partnershipApplication.findUnique({ where: { clientToken } });
    return row ? toView(row) : null;
  }

  /**
   * R1–R5 — stores the application, then sends the two emails. Submitting the
   * same attempt again (a double tap, a retry after a dropped connection)
   * returns the first application rather than a second one (R3).
   */
  async function submit(input: SubmitInput, from: { ip: string }): Promise<Receipt> {
    const clientToken = token(input.clientToken);
    const earlier = await byToken(clientToken);
    if (earlier) return receipt(earlier);

    const fields = checked(clientToken, input);
    const email = fields.profile.email as string;

    // R5 — a bot is shown what a person would be, and nothing is stored.
    if (input.trap?.trim()) {
      return { reference: reference(), organisationName: fields.organisationName ?? (fields.profile.contactName as string), categories: fields.categories, submittedAt: now() };
    }
    await throttle([
      { key: `partnership:ip:h:${from.ip}`, window: SUBMIT_WINDOWS.perIpHour },
      { key: `partnership:ip:d:${from.ip}`, window: SUBMIT_WINDOWS.perIpDay },
      { key: `partnership:email:${email}`, window: SUBMIT_WINDOWS.perEmailDay },
    ]);

    let created: PartnershipApplication | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const id = newId();
      try {
        const row = await db.$transaction(async (tx) => {
          const r = await tx.partnershipApplication.create({
            data: {
              id,
              reference: reference(),
              clientToken,
              applicantType: fields.applicantType,
              organisationName: fields.organisationName,
              city: fields.profile.city as string,
              state: fields.profile.state as string,
              contactName: fields.profile.contactName as string,
              contactEmail: email,
              contactPhone: fields.profile.phone as string,
              categories: fields.categories,
              profile: fields.profile as Prisma.InputJsonValue,
              sections: fields.sections as Prisma.InputJsonValue,
              consentAccurate: true,
              consentContact: true,
              consentPublish: input.consentPublish,
              consentedAt: now(),
            },
          });
          await tx.partnershipStatusChange.create({
            data: { id: newId(), applicationId: id, fromStatus: null, toStatus: 'submitted', byUserId: null },
          });
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
    if (!created) throw new Error('partnerships: no free reference after 5 tries');

    // R4 — the application is stored; an email that fails says so in the portal and nothing more.
    const sent = await deps.mail.confirmation(created);
    await db.partnershipApplication.update({ where: { id: created.id }, data: { confirmationEmail: sent ? 'sent' : 'failed' } });
    await deps.mail.team(created);
    return receipt(created);
  }

  /**
   * R5 — a signature for ONE image, uploaded straight to Cloudinary into the
   * attempt's own folder. Its public_id comes back in the answers and is
   * checked against that folder (ADR 0003 §C2).
   */
  async function uploadSignature(rawToken: string, from: { ip: string }): Promise<UploadSignature> {
    const clientToken = token(rawToken);
    await throttle([{ key: `partnership:upload:${from.ip}`, window: UPLOAD_WINDOW }]);
    return deps.media.signUpload({ publicId: newId(), folder: deps.media.root(clientToken) });
  }

  // --- the portal ---------------------------------------------------------------------------

  function where(f: Filter): Prisma.PartnershipApplicationWhereInput {
    const q = f.search?.trim();
    const city = f.city?.trim();
    return {
      ...(f.status ? { status: f.status } : {}),
      ...(f.category ? { categories: { has: f.category } } : {}),
      ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
      ...(q
        ? {
            OR: [
              { organisationName: { contains: q, mode: 'insensitive' } },
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
  async function list(f: Filter, page: { limit: number; offset: number }): Promise<{ total: number; items: PartnershipApplication[] }> {
    const w = where(f);
    const [total, rows] = await Promise.all([
      db.partnershipApplication.count({ where: w }),
      db.partnershipApplication.findMany({
        where: w,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(page.limit, 1), PAGE_MAX),
        skip: Math.max(page.offset, 0),
      }),
    ]);
    return { total, items: rows.map(toView) };
  }

  /** R6 — every match, for the CSV. */
  async function exportRows(f: Filter): Promise<PartnershipApplication[]> {
    const rows = await db.partnershipApplication.findMany({ where: where(f), orderBy: { createdAt: 'desc' }, take: EXPORT_MAX });
    return rows.map(toView);
  }

  async function byId(id: string): Promise<PartnershipApplication | null> {
    if (!UUID.test(id)) return null;
    const row = await db.partnershipApplication.findUnique({ where: { id } });
    return row ? toView(row) : null;
  }

  async function found(id: string): Promise<PartnershipApplication> {
    const a = await byId(id);
    if (!a) throw new UserError(PartnershipCode.PARTNERSHIP_NOT_FOUND, 'That application could not be found.');
    return a;
  }

  /** The cities applications came from, for the filter. */
  async function cities(): Promise<string[]> {
    const rows = await db.partnershipApplication.findMany({ distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' } });
    return rows.map((r) => r.city);
  }

  async function counts(): Promise<Record<PartnershipStatus, number>> {
    const rows = await db.partnershipApplication.groupBy({ by: ['status'], _count: { _all: true } });
    const out = Object.fromEntries(PARTNERSHIP_STATUSES.map((s) => [s, 0])) as Record<PartnershipStatus, number>;
    for (const r of rows) out[r.status as PartnershipStatus] = r._count._all;
    return out;
  }

  /**
   * R7 — other applications that look like the same organisation: the same
   * email or phone, or the same name. Newest first. A hint for staff, who
   * decide by linking.
   */
  async function possibleDuplicates(a: PartnershipApplication): Promise<PartnershipApplication[]> {
    const rows = await db.partnershipApplication.findMany({
      where: {
        id: { not: a.id },
        OR: [
          { contactEmail: a.contactEmail },
          { contactPhone: a.contactPhone },
          ...(a.organisationName ? [{ organisationName: { equals: a.organisationName, mode: 'insensitive' as const } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return rows.map(toView);
  }

  /** R7 — the applications linked to this one, both ways. */
  async function linked(a: PartnershipApplication): Promise<PartnershipApplication[]> {
    const rows = await db.partnershipApplication.findMany({
      where: { OR: [{ linkedApplicationId: a.id }, ...(a.linkedApplicationId ? [{ id: a.linkedApplicationId }] : [])] },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  async function notes(applicationId: string): Promise<PartnershipNote[]> {
    return db.partnershipNote.findMany({ where: { applicationId }, orderBy: { createdAt: 'desc' } });
  }

  async function history(applicationId: string): Promise<StatusChange[]> {
    const rows = await db.partnershipStatusChange.findMany({ where: { applicationId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.fromStatus as PartnershipStatus | null,
      toStatus: r.toStatus as PartnershipStatus,
      byUserId: r.byUserId,
      createdAt: r.createdAt,
    }));
  }

  /** R6 — moves the application on, and records who did. The same status again changes nothing. */
  async function setStatus(staff: { userId: string }, id: string, status: PartnershipStatus): Promise<PartnershipApplication> {
    if (!PARTNERSHIP_STATUSES.includes(status)) throw new UserError(PartnershipCode.INVALID_STATUS, 'That is not a status.');
    const before = await found(id);
    if (before.status === status) return before;
    const row = await db.$transaction(async (tx) => {
      const r = await tx.partnershipApplication.update({ where: { id }, data: { status } });
      await tx.partnershipStatusChange.create({
        data: { id: newId(), applicationId: id, fromStatus: before.status, toStatus: status, byUserId: staff.userId },
      });
      return r;
    });
    return toView(row);
  }

  /** R6 — a note for staff. The applicant never sees it. */
  async function addNote(staff: { userId: string }, id: string, body: string): Promise<PartnershipNote> {
    await found(id);
    const text = body.trim();
    if (text.length === 0 || text.length > NOTE_MAX) {
      throw new UserError(PartnershipCode.INVALID_NOTE, `Write a note of up to ${NOTE_MAX.toLocaleString('en-IN')} characters.`);
    }
    return db.partnershipNote.create({ data: { id: newId(), applicationId: id, authorId: staff.userId, body: text } });
  }

  /**
   * R6, R7 — the working fields. Each one is left alone when not given; null
   * clears it. `verified` stamps who checked the details, and when.
   */
  async function update(
    staff: { userId: string },
    id: string,
    patch: {
      verified?: boolean | null;
      assignedTo?: string | null;
      followUpOn?: string | null;
      linkedApplicationId?: string | null;
    },
  ): Promise<PartnershipApplication> {
    const before = await found(id);
    const data: Prisma.PartnershipApplicationUncheckedUpdateInput = {};
    if (patch.verified !== undefined) {
      data.verifiedAt = patch.verified ? (before.verifiedAt ?? now()) : null;
      data.verifiedBy = patch.verified ? (before.verifiedBy ?? staff.userId) : null;
    }
    if (patch.assignedTo !== undefined) {
      if (patch.assignedTo !== null) {
        const isStaff = UUID.test(patch.assignedTo) && (await db.platformStaff.findUnique({ where: { userId: patch.assignedTo } }));
        if (!isStaff) throw new UserError(PartnershipCode.INVALID_ASSIGNEE, 'Assign it to someone on the PL4Y team.');
      }
      data.assignedTo = patch.assignedTo;
    }
    if (patch.followUpOn !== undefined) {
      if (patch.followUpOn !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(patch.followUpOn) || Number.isNaN(Date.parse(patch.followUpOn)))) {
        throw new UserError('INVALID_ANSWER', 'Pick a follow-up date.');
      }
      data.followUpOn = patch.followUpOn ? new Date(`${patch.followUpOn}T00:00:00Z`) : null;
    }
    if (patch.linkedApplicationId !== undefined) {
      if (patch.linkedApplicationId !== null) {
        const other = patch.linkedApplicationId === id ? null : await byId(patch.linkedApplicationId);
        if (!other) throw new UserError(PartnershipCode.INVALID_LINK, 'Link it to a different, existing application.');
      }
      data.linkedApplicationId = patch.linkedApplicationId;
    }
    const row = await db.partnershipApplication.update({ where: { id }, data });
    return toView(row);
  }

  return {
    submit,
    uploadSignature,
    list,
    exportRows,
    byId,
    cities,
    counts,
    possibleDuplicates,
    linked,
    notes,
    history,
    setStatus,
    addNote,
    update,
  };
}

export type PartnershipService = ReturnType<typeof createPartnershipService>;
