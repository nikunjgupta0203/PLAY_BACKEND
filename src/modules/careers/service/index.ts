/**
 * careers — the PL4Y careers application form (Campus Ambassador Program and
 * Sales Internship) and its review in the portal (docs/modules/24-careers.md).
 *
 * R1 Anyone with the link applies, without an account: an opportunity, the
 *    basic details, that opportunity's questions, then one consent.
 * R2 Answers are checked against form.ts (the same checker as partnerships).
 * R3 Submitting the same attempt (client token) twice returns the first one.
 * R4 The applicant gets a confirmation email and the team a heads-up; both are
 *    best effort and never lose the application.
 * R5 A resume is optional: one PDF of at most 5 MB, uploaded straight to
 *    Cloudinary as a private file into the attempt's own folder. The file
 *    named on submit must be in that folder; when Cloudinary can say, it must
 *    exist and be within the size. Staff open it through a link that expires.
 * R6 Throttled per IP and per email; a filled hidden field gets a fake receipt.
 * R7 Staff move an application through NEW → UNDER_REVIEW → SHORTLISTED →
 *    INTERVIEW → SELECTED / REJECTED, every move recorded with who and when,
 *    and keep notes the applicant never sees.
 * R8 Kept for the recruitment only: 12 months after its last status change
 *    (the decision, for a SELECTED or REJECTED one), `purge` deletes the
 *    application, its notes, history and resume. The worker runs it daily.
 */
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
// The pure answer checker partnerships owns; its index would also start that module's mail and media.
import { check, type Answers } from '../../partnerships/service/answers.js';
import { BASIC, OPPORTUNITIES, OPPORTUNITY_CODES, QUESTIONS, type Opportunity } from './form.js';

export const CareerCode = {
  /** R3 — the form's attempt id is missing or not a UUID. Reload the form. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  INVALID_OPPORTUNITY: 'INVALID_OPPORTUNITY',
  /** R1 — the consent on the review step. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** R5 — the resume named is not this attempt's, is missing, or too big. */
  INVALID_RESUME: 'INVALID_RESUME',
  /** R6 — too many applications or uploads from one place. */
  CAREER_THROTTLED: 'CAREER_THROTTLED',
  CAREER_NOT_FOUND: 'CAREER_NOT_FOUND',
  NO_RESUME: 'NO_RESUME',
  INVALID_STATUS: 'INVALID_STATUS',
  INVALID_NOTE: 'INVALID_NOTE',
} as const;

/** R7 — in the order an application usually moves through them. */
export const CAREER_STATUSES = ['new', 'under_review', 'shortlisted', 'interview', 'selected', 'rejected'] as const;
export type CareerStatus = (typeof CAREER_STATUSES)[number];

/** R6 — per IP and per email. A real applicant sends one or two. */
export const SUBMIT_WINDOWS = {
  perIpHour: { seconds: 3600, max: 10 },
  perIpDay: { seconds: 86_400, max: 30 },
  perEmailDay: { seconds: 86_400, max: 5 },
} satisfies Record<string, Window>;
const UPLOAD_WINDOW: Window = { seconds: 3600, max: 20 };

/** R5 */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
/** R8 */
export const RETENTION_DAYS = 365;

const NOTE_MAX = 4000;
const PAGE_MAX = 100;
const EXPORT_MAX = 5000;
const RESUME_NAME_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No 0/O, 1/I/L: a reference is read out over the phone. */
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface Resume {
  publicId: string;
  /** The file name as the applicant had it, for the portal. */
  name: string;
}

export interface CareerApplication {
  id: string;
  reference: string;
  opportunity: Opportunity;
  fullName: string;
  email: string;
  phone: string;
  city: string;
  organisation: string;
  basic: Answers;
  answers: Answers;
  resume: Resume | null;
  consentedAt: Date;
  status: CareerStatus;
  statusChangedAt: Date;
  confirmationEmail: 'pending' | 'sent' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

/** What the applicant is shown once it is sent: nothing they did not type themselves. */
export interface Receipt {
  reference: string;
  opportunity: Opportunity;
  fullName: string;
  submittedAt: Date;
}

export interface SubmitInput {
  clientToken: string;
  opportunity: string;
  basic: Record<string, unknown>;
  answers: Record<string, unknown>;
  resume?: { publicId: string; name: string } | null;
  consent: boolean;
  /** R6 — a field people never see. Anything in it means a bot filled the form. */
  trap?: string | null;
}

export interface CareerNote {
  id: string;
  applicationId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface StatusChange {
  id: string;
  fromStatus: CareerStatus | null;
  toStatus: CareerStatus;
  byUserId: string | null;
  createdAt: Date;
}

export interface Filter {
  /** Name, email, phone, city, college / organisation or reference. */
  search?: string | null;
  opportunity?: Opportunity | null;
  status?: CareerStatus | null;
}

export interface ResumeUpload {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  publicId: string;
  folder: string;
  uploadPreset: string;
  type: 'private';
  signature: string;
  uploadUrl: string;
  expiresAt: Date;
}

export interface CareerDeps {
  db: Db;
  limiter: { consumeAll(checks: { key: string; window: Window }[]): Promise<LimitResult> };
  /** R5 */
  files: {
    root(clientToken: string): string;
    signUpload(opts: { publicId: string; folder: string }): ResumeUpload;
    /** The stored size, or null if there is no such file. Throws when Cloudinary can't be asked. */
    bytes(publicId: string): Promise<number | null>;
    downloadUrl(publicId: string): string;
    destroy(publicId: string): Promise<void>;
  };
  /** R4 — both best effort: a failure is logged, never thrown. */
  mail: {
    confirmation(application: CareerApplication): Promise<boolean>;
    team(application: CareerApplication): Promise<void>;
  };
  now?: () => Date;
}

type Row = Prisma.CareerApplicationGetPayload<object>;

const toView = (r: Row): CareerApplication => ({
  id: r.id,
  reference: r.reference,
  opportunity: r.opportunity as Opportunity,
  fullName: r.fullName,
  email: r.email,
  phone: r.phone,
  city: r.city,
  organisation: r.organisation,
  basic: r.basic as Answers,
  answers: r.answers as Answers,
  resume: r.resumePublicId ? { publicId: r.resumePublicId, name: r.resumeName ?? 'resume.pdf' } : null,
  consentedAt: r.consentedAt,
  status: r.status as CareerStatus,
  statusChangedAt: r.statusChangedAt,
  confirmationEmail: r.confirmationEmail as CareerApplication['confirmationEmail'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const receipt = (a: CareerApplication): Receipt => ({
  reference: a.reference,
  opportunity: a.opportunity,
  fullName: a.fullName,
  submittedAt: a.createdAt,
});

function reference(opportunity: Opportunity): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `${OPPORTUNITY_CODES[opportunity]}-${s}`;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const refuse = (code: string, field: string, message: string) => new UserError(code, message, { details: { field } });

/** R1, R2 — everything the applicant typed, checked, in the shape it is stored in. */
export function checked(input: Pick<SubmitInput, 'opportunity' | 'basic' | 'answers' | 'consent'>) {
  const opportunity = input.opportunity as Opportunity;
  if (!OPPORTUNITIES.includes(opportunity)) {
    throw refuse(CareerCode.INVALID_OPPORTUNITY, 'opportunity', 'Choose the Campus Ambassador Program or the Sales Internship.');
  }
  // No images on this form: the resume is checked on its own.
  const basic = check(BASIC, asObject(input.basic), ['basic'], '');
  const answers = check(QUESTIONS[opportunity], asObject(input.answers), ['answers'], '');
  if (!input.consent) throw refuse(CareerCode.CONSENT_REQUIRED, 'consent', 'Tick the confirmation above the submit button.');
  return { opportunity, basic, answers };
}

/** "Résumé (final).pdf" stays readable; path parts and control characters go. */
function fileName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  const base = s.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, RESUME_NAME_MAX);
  return clean || 'resume.pdf';
}

export function createCareerService(deps: CareerDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function token(raw: string): string {
    if (!UUID.test(raw)) throw new UserError(CareerCode.INVALID_TOKEN, 'This form needs reloading. Your answers are kept on this device.');
    return raw.toLowerCase();
  }

  async function throttle(checks: { key: string; window: Window }[]) {
    const limit = await deps.limiter.consumeAll(checks);
    if (!limit.allowed) {
      throw new UserError(CareerCode.CAREER_THROTTLED, 'Too many attempts from here. Try again a little later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
  }

  async function byToken(clientToken: string): Promise<CareerApplication | null> {
    const row = await db.careerApplication.findUnique({ where: { clientToken } });
    return row ? toView(row) : null;
  }

  /** R5 — the resume named on submit, checked against the attempt's folder and, when possible, Cloudinary. */
  async function resumeFor(clientToken: string, raw: SubmitInput['resume']): Promise<Resume | null> {
    if (!raw || (typeof raw.publicId === 'string' && raw.publicId.trim() === '')) return null;
    const publicId = typeof raw.publicId === 'string' ? raw.publicId.trim() : '';
    const root = deps.files.root(clientToken);
    const ok = publicId.startsWith(`${root}/`) && publicId.length <= 200 && !publicId.includes('..') && /\.pdf$/i.test(publicId);
    if (!ok) throw refuse(CareerCode.INVALID_RESUME, 'basic.resume', 'Upload your resume again.');
    let bytes: number | null | undefined;
    try {
      bytes = await deps.files.bytes(publicId);
    } catch {
      // Cloudinary can't be asked right now: the folder check above still holds, and an application is never lost for it.
      bytes = undefined;
    }
    if (bytes === null) throw refuse(CareerCode.INVALID_RESUME, 'basic.resume', 'Your resume didn’t finish uploading. Upload it again.');
    if (bytes !== undefined && bytes > RESUME_MAX_BYTES) {
      await deps.files.destroy(publicId).catch(() => undefined);
      throw refuse(CareerCode.INVALID_RESUME, 'basic.resume', 'Your resume is over 5 MB. Upload a smaller PDF.');
    }
    return { publicId, name: fileName(raw.name) };
  }

  /** R5 — a signature for ONE PDF, uploaded straight to Cloudinary as a private file. */
  async function resumeUpload(rawToken: string, from: { ip: string }): Promise<ResumeUpload> {
    const clientToken = token(rawToken);
    await throttle([{ key: `career:upload:${from.ip}`, window: UPLOAD_WINDOW }]);
    return deps.files.signUpload({ publicId: `${newId()}.pdf`, folder: deps.files.root(clientToken) });
  }

  /** R1–R6 — stores the application, then sends the two emails. */
  async function submit(input: SubmitInput, from: { ip: string }): Promise<Receipt> {
    const clientToken = token(input.clientToken);
    const earlier = await byToken(clientToken);
    if (earlier) return receipt(earlier);

    const f = checked(input);
    const email = f.basic.email as string;

    // R6 — a bot is shown what a person would be, and nothing is stored.
    if (input.trap?.trim()) {
      return { reference: reference(f.opportunity), opportunity: f.opportunity, fullName: f.basic.fullName as string, submittedAt: now() };
    }
    await throttle([
      { key: `career:ip:h:${from.ip}`, window: SUBMIT_WINDOWS.perIpHour },
      { key: `career:ip:d:${from.ip}`, window: SUBMIT_WINDOWS.perIpDay },
      { key: `career:email:${email}`, window: SUBMIT_WINDOWS.perEmailDay },
    ]);
    const resume = await resumeFor(clientToken, input.resume);

    let created: CareerApplication | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const id = newId();
      try {
        const row = await db.$transaction(async (tx) => {
          const at = now();
          const r = await tx.careerApplication.create({
            data: {
              id,
              reference: reference(f.opportunity),
              clientToken,
              opportunity: f.opportunity,
              fullName: f.basic.fullName as string,
              email,
              phone: f.basic.phone as string,
              city: f.basic.city as string,
              organisation: f.basic.organisation as string,
              basic: f.basic as Prisma.InputJsonValue,
              answers: f.answers as Prisma.InputJsonValue,
              resumePublicId: resume?.publicId ?? null,
              resumeName: resume?.name ?? null,
              consentedAt: at,
              statusChangedAt: at,
            },
          });
          await tx.careerStatusChange.create({ data: { id: newId(), applicationId: id, fromStatus: null, toStatus: 'new', byUserId: null } });
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
    if (!created) throw new Error('careers: no free reference after 5 tries');

    // R4 — the application is stored; an email that fails says so in the portal and nothing more.
    const sent = await deps.mail.confirmation(created);
    await db.careerApplication.update({ where: { id: created.id }, data: { confirmationEmail: sent ? 'sent' : 'failed' } });
    await deps.mail.team(created);
    return receipt(created);
  }

  // --- the portal ---------------------------------------------------------------------------

  function where(f: Filter): Prisma.CareerApplicationWhereInput {
    const q = f.search?.trim();
    return {
      ...(f.status ? { status: f.status } : {}),
      ...(f.opportunity ? { opportunity: f.opportunity } : {}),
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { city: { contains: q, mode: 'insensitive' } },
              { organisation: { contains: q, mode: 'insensitive' } },
              // The college an ambassador represents may differ from where they said they study.
              { answers: { path: ['college'], string_contains: q } },
              { reference: { contains: q.toUpperCase() } },
            ],
          }
        : {}),
    };
  }

  /** R7 — newest first. */
  async function list(f: Filter, page: { limit: number; offset: number }): Promise<{ total: number; items: CareerApplication[] }> {
    const w = where(f);
    const [total, rows] = await Promise.all([
      db.careerApplication.count({ where: w }),
      db.careerApplication.findMany({
        where: w,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(page.limit, 1), PAGE_MAX),
        skip: Math.max(page.offset, 0),
      }),
    ]);
    return { total, items: rows.map(toView) };
  }

  async function exportRows(f: Filter): Promise<CareerApplication[]> {
    const rows = await db.careerApplication.findMany({ where: where(f), orderBy: { createdAt: 'desc' }, take: EXPORT_MAX });
    return rows.map(toView);
  }

  async function byId(id: string): Promise<CareerApplication | null> {
    if (!UUID.test(id)) return null;
    const row = await db.careerApplication.findUnique({ where: { id } });
    return row ? toView(row) : null;
  }

  async function found(id: string): Promise<CareerApplication> {
    const a = await byId(id);
    if (!a) throw new UserError(CareerCode.CAREER_NOT_FOUND, 'That application could not be found.');
    return a;
  }

  /** Every opportunity × status, zeros included. */
  async function counts(): Promise<{ opportunity: Opportunity; status: CareerStatus; count: number }[]> {
    const rows = await db.careerApplication.groupBy({ by: ['opportunity', 'status'], _count: { _all: true } });
    const n = new Map(rows.map((r) => [`${r.opportunity}:${r.status}`, r._count._all]));
    return OPPORTUNITIES.flatMap((opportunity) =>
      CAREER_STATUSES.map((status) => ({ opportunity, status, count: n.get(`${opportunity}:${status}`) ?? 0 })),
    );
  }

  /** Other applications with the same email: a second try, or both opportunities. */
  async function others(a: CareerApplication): Promise<CareerApplication[]> {
    const rows = await db.careerApplication.findMany({
      where: { email: a.email, id: { not: a.id } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return rows.map(toView);
  }

  async function notes(applicationId: string): Promise<CareerNote[]> {
    return db.careerNote.findMany({ where: { applicationId }, orderBy: { createdAt: 'desc' } });
  }

  async function history(applicationId: string): Promise<StatusChange[]> {
    const rows = await db.careerStatusChange.findMany({ where: { applicationId }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.fromStatus as CareerStatus | null,
      toStatus: r.toStatus as CareerStatus,
      byUserId: r.byUserId,
      createdAt: r.createdAt,
    }));
  }

  /** R7 — moves the application on, and records who did and when. The same status again changes nothing. */
  async function setStatus(staff: { userId: string }, id: string, status: CareerStatus): Promise<CareerApplication> {
    if (!CAREER_STATUSES.includes(status)) throw new UserError(CareerCode.INVALID_STATUS, 'That is not a status.');
    const before = await found(id);
    if (before.status === status) return before;
    const row = await db.$transaction(async (tx) => {
      const r = await tx.careerApplication.update({ where: { id }, data: { status, statusChangedAt: now() } });
      await tx.careerStatusChange.create({
        data: { id: newId(), applicationId: id, fromStatus: before.status, toStatus: status, byUserId: staff.userId },
      });
      return r;
    });
    return toView(row);
  }

  /** R7 — a note for staff. The applicant never sees it. */
  async function addNote(staff: { userId: string }, id: string, body: string): Promise<CareerNote> {
    await found(id);
    const text = body.trim();
    if (text.length === 0 || text.length > NOTE_MAX) {
      throw new UserError(CareerCode.INVALID_NOTE, `Write a note of up to ${NOTE_MAX.toLocaleString('en-IN')} characters.`);
    }
    return db.careerNote.create({ data: { id: newId(), applicationId: id, authorId: staff.userId, body: text } });
  }

  /** R5 — a link to the resume that stops working in a few minutes. */
  async function resumeLink(id: string): Promise<string> {
    const a = await found(id);
    if (!a.resume) throw new UserError(CareerCode.NO_RESUME, 'This applicant didn’t upload a resume.');
    return deps.files.downloadUrl(a.resume.publicId);
  }

  /** R8 — deletes every application whose status has not changed for RETENTION_DAYS. Returns how many. */
  async function purge(): Promise<number> {
    const before = new Date(now().getTime() - RETENTION_DAYS * 86_400_000);
    const rows = await db.careerApplication.findMany({
      where: { statusChangedAt: { lt: before } },
      select: { id: true, resumePublicId: true },
      take: 500,
    });
    for (const r of rows) {
      if (r.resumePublicId) await deps.files.destroy(r.resumePublicId);
      await db.careerApplication.delete({ where: { id: r.id } });
    }
    return rows.length;
  }

  return { resumeUpload, submit, list, exportRows, byId, counts, others, notes, history, setStatus, addNote, resumeLink, purge };
}

export type CareerService = ReturnType<typeof createCareerService>;
