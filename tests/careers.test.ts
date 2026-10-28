/**
 * careers — service tests against a real Postgres (conventions.md §5).
 *
 * Every numbered rule has a test that names it, so `grep 'careers R3'` finds it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import {
  CareerCode,
  createCareerService,
  RESUME_MAX_BYTES,
  RETENTION_DAYS,
  type CareerApplication,
  type CareerService,
  type SubmitInput,
} from '../src/modules/careers/service/index.js';
import { AnswerCode } from '../src/modules/partnerships/service/answers.js';
import type { Db } from '../src/platform/db.js';
import { isUserError, type UserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createRateLimiter } from '../src/platform/rateLimit.js';

let prisma: PrismaClient;
let service: CareerService;
let clock = new Date('2026-10-28T06:00:00Z');

const mail = {
  confirmations: [] as CareerApplication[],
  team: [] as CareerApplication[],
  failConfirmation: false,
  reset() {
    this.confirmations = [];
    this.team = [];
    this.failConfirmation = false;
  },
};

/** The fake Cloudinary: what is "stored", and what was deleted. */
const files = {
  stored: new Map<string, number>(),
  destroyed: [] as string[],
  down: false,
  reset() {
    this.stored.clear();
    this.destroyed = [];
    this.down = false;
  },
};

let ipCounter = 0;
let ip = '';

const basic = (over: Record<string, unknown> = {}) => ({
  fullName: '  Aanya   Sharma ',
  email: ' Aanya.Sharma@Gmail.com ',
  phone: '+91 98765 43210',
  city: 'Pune',
  organisation: 'Symbiosis College',
  courseYear: 'BBA, 2nd year',
  linkedin: 'linkedin.com/in/aanya',
  heardFrom: 'instagram',
  ...over,
});

const ambassador = (over: Record<string, unknown> = {}) => ({
  college: 'Symbiosis College of Arts & Commerce',
  collegeCity: 'Pune',
  studyYear: 'year_2',
  communities: 'Sports committee',
  leadership: 'Ran the cricket fest',
  reach: '100_300',
  platforms: ['whatsapp', 'instagram'],
  promotion: 'A weekend badminton ladder.',
  motivation: 'I already organise the games.',
  weeklyHours: '4_5',
  ...over,
});

const sales = (over: Record<string, unknown> = {}) => ({
  interest: 'Talking to people.',
  hasExperience: false,
  outreachOk: true,
  pitchingOk: true,
  partnerPitch: 'More bookings at off-peak hours.',
  dailyHours: '3_4',
  availability: 'immediate',
  workMode: 'hybrid',
  whyYou: 'I sold event passes for two years.',
  ...over,
});

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  clientToken: randomUUID(),
  opportunity: 'campus_ambassador',
  basic: basic(),
  answers: ambassador(),
  consent: true,
  ...over,
});

const submit = (i: SubmitInput) => service.submit(i, { ip });

const refused = async (fn: () => Promise<unknown>): Promise<UserError> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e;
    throw e;
  }
  throw new Error('expected a user error');
};

const stored = async (reference: string) => {
  const row = await prisma.careerApplication.findUnique({ where: { reference } });
  if (!row) throw new Error(`no application ${reference}`);
  return (await service.byId(row.id))!;
};

async function makeStaff(email: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email, displayName: email.split('@')[0]! } });
  await prisma.platformStaff.create({ data: { userId, role: 'support' } });
  return { userId };
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const db = prisma as unknown as Db;
  service = createCareerService({
    db,
    limiter: createRateLimiter(db),
    now: () => clock,
    files: {
      root: (t) => `pl4y/careers/${t}`,
      signUpload: (o) => ({
        cloudName: 'demo',
        apiKey: 'key',
        timestamp: 1,
        publicId: o.publicId,
        folder: o.folder,
        uploadPreset: 'pl4y_signed',
        type: 'private',
        signature: 'sig',
        uploadUrl: 'https://api.cloudinary.com/v1_1/demo/raw/upload',
        expiresAt: new Date(),
      }),
      async bytes(id) {
        if (files.down) throw new Error('offline');
        return files.stored.get(id) ?? null;
      },
      downloadUrl: (id) => `https://download.test/${id}?expires=300`,
      async destroy(id) {
        files.destroyed.push(id);
        files.stored.delete(id);
      },
    },
    mail: {
      async confirmation(a) {
        if (mail.failConfirmation) return false;
        mail.confirmations.push(a);
        return true;
      },
      async team(a) {
        mail.team.push(a);
      },
    },
  });
}, 120_000);

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  mail.reset();
  files.reset();
  clock = new Date('2026-10-28T06:00:00Z');
  ip = `198.51.100.${++ipCounter}`;
});

describe('careers R1, R2 — the form, stored', () => {
  it('a campus ambassador applies; answers are cleaned and the application starts NEW', async () => {
    const r = await submit(input());
    expect(r.reference).toMatch(/^CA-[A-HJ-NP-Z2-9]{6}$/);
    expect(r.fullName).toBe('Aanya Sharma');
    expect(r.opportunity).toBe('campus_ambassador');

    const a = await stored(r.reference);
    expect(a.status).toBe('new');
    expect(a.email).toBe('aanya.sharma@gmail.com');
    expect(a.basic.linkedin).toBe('https://linkedin.com/in/aanya');
    expect(a.answers.platforms).toEqual(['instagram', 'whatsapp']);
    expect(a.resume).toBeNull();
    const history = await service.history(a.id);
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.byUserId])).toEqual([[null, 'new', null]]);
  });

  it('a sales intern applies with an SI reference', async () => {
    const r = await submit(input({ opportunity: 'sales_internship', answers: sales() }));
    expect(r.reference).toMatch(/^SI-/);
    expect((await stored(r.reference)).answers.hasExperience).toBe(false);
  });

  it('the experience question is required only after a yes', async () => {
    const e = await refused(() => submit(input({ opportunity: 'sales_internship', answers: sales({ hasExperience: true }) })));
    expect(e.code).toBe(AnswerCode.ANSWER_REQUIRED);
    expect(e.details?.field).toBe('answers.experience');

    const r = await submit(input({ opportunity: 'sales_internship', answers: sales({ hasExperience: true, experience: 'Retail, two summers.' }) }));
    expect((await stored(r.reference)).answers.experience).toBe('Retail, two summers.');
  });

  it('answers to the other opportunity, or unasked follow-ups, are dropped', async () => {
    const r = await submit(input({ answers: { ...ambassador(), whyYou: 'stray', platformsOther: 'Snapchat' } }));
    const a = await stored(r.reference);
    expect(a.answers.whyYou).toBeUndefined();
    expect(a.answers.platformsOther).toBeUndefined();
  });

  it('refuses a bad email, a bad phone, a missing answer, an unknown opportunity and no consent', async () => {
    expect((await refused(() => submit(input({ basic: basic({ email: 'aanya@gmail' }) })))).details?.field).toBe('basic.email');
    expect((await refused(() => submit(input({ basic: basic({ phone: '12' }) })))).details?.field).toBe('basic.phone');
    expect((await refused(() => submit(input({ answers: ambassador({ reach: undefined }) })))).details?.field).toBe('answers.reach');
    expect((await refused(() => submit(input({ opportunity: 'ceo' })))).code).toBe(CareerCode.INVALID_OPPORTUNITY);
    expect((await refused(() => submit(input({ consent: false })))).code).toBe(CareerCode.CONSENT_REQUIRED);
    expect(await prisma.careerApplication.count()).toBe(0);
  });
});

describe('careers R3 — one attempt, one application', () => {
  it('the same client token twice returns the first receipt', async () => {
    const i = input();
    const [a, b] = await Promise.all([submit(i), submit(i)]);
    expect(a.reference).toBe(b.reference);
    expect(await submit(i)).toEqual(a);
    expect(await prisma.careerApplication.count()).toBe(1);
  });

  it('refuses a token that is not a UUID', async () => {
    expect((await refused(() => submit(input({ clientToken: 'x' })))).code).toBe(CareerCode.INVALID_TOKEN);
  });
});

describe('careers R4 — emails', () => {
  it('the applicant and the team hear about it; a failed confirmation is recorded, not thrown', async () => {
    await submit(input());
    expect(mail.confirmations).toHaveLength(1);
    expect(mail.team).toHaveLength(1);

    mail.failConfirmation = true;
    const r = await submit(input());
    expect((await stored(r.reference)).confirmationEmail).toBe('failed');
  });
});

describe('careers R5 — the resume', () => {
  it('signs an upload into the attempt’s own folder, as a private PDF', async () => {
    const token = randomUUID();
    const u = await service.resumeUpload(token, { ip });
    expect(u.folder).toBe(`pl4y/careers/${token}`);
    expect(u.publicId).toMatch(/\.pdf$/);
    expect(u.type).toBe('private');
  });

  it('keeps a resume from this attempt’s folder', async () => {
    const token = randomUUID();
    const id = `pl4y/careers/${token}/${newId()}.pdf`;
    files.stored.set(id, 200_000);
    const r = await submit(input({ clientToken: token, resume: { publicId: id, name: 'C:\\fakepath\\Aanya CV.pdf' } }));
    const a = await stored(r.reference);
    expect(a.resume).toEqual({ publicId: id, name: 'Aanya CV.pdf' });
    expect(await service.resumeLink(a.id)).toBe(`https://download.test/${id}?expires=300`);
  });

  it('refuses another attempt’s file, a missing file and one over 5 MB', async () => {
    const token = randomUUID();
    const other = `pl4y/careers/${randomUUID()}/${newId()}.pdf`;
    files.stored.set(other, 1000);
    const e1 = await refused(() => submit(input({ clientToken: token, resume: { publicId: other, name: 'a.pdf' } })));
    expect(e1.code).toBe(CareerCode.INVALID_RESUME);
    expect(e1.details?.field).toBe('basic.resume');

    const missing = `pl4y/careers/${token}/${newId()}.pdf`;
    expect((await refused(() => submit(input({ clientToken: token, resume: { publicId: missing, name: 'a.pdf' } })))).code).toBe(
      CareerCode.INVALID_RESUME,
    );

    const big = `pl4y/careers/${token}/${newId()}.pdf`;
    files.stored.set(big, RESUME_MAX_BYTES + 1);
    expect((await refused(() => submit(input({ clientToken: token, resume: { publicId: big, name: 'a.pdf' } })))).code).toBe(
      CareerCode.INVALID_RESUME,
    );
    expect(files.destroyed).toEqual([big]);
    expect(await prisma.careerApplication.count()).toBe(0);
  });

  it('when Cloudinary cannot be asked, the folder check alone lets it through', async () => {
    files.down = true;
    const token = randomUUID();
    const id = `pl4y/careers/${token}/${newId()}.pdf`;
    const r = await submit(input({ clientToken: token, resume: { publicId: id, name: 'cv.pdf' } }));
    expect((await stored(r.reference)).resume?.publicId).toBe(id);
  });

  it('no resume, no link', async () => {
    const r = await submit(input());
    expect((await refused(async () => service.resumeLink((await stored(r.reference)).id))).code).toBe(CareerCode.NO_RESUME);
  });
});

describe('careers R6 — spam', () => {
  it('a filled hidden field gets a receipt and stores nothing', async () => {
    const r = await submit(input({ trap: 'http://spam' }));
    expect(r.reference).toMatch(/^CA-/);
    expect(await prisma.careerApplication.count()).toBe(0);
    expect(mail.confirmations).toHaveLength(0);
  });

  it('five a day per email, then throttled', async () => {
    for (let i = 0; i < 5; i++) {
      ip = `203.0.113.${i}`;
      await submit(input());
    }
    ip = '203.0.113.99';
    expect((await refused(() => submit(input()))).code).toBe(CareerCode.CAREER_THROTTLED);
  });
});

describe('careers R7 — the portal', () => {
  it('filters by opportunity, status and search (name, college, city, email)', async () => {
    await submit(input());
    ip = '192.0.2.1';
    await submit(
      input({
        opportunity: 'sales_internship',
        basic: basic({ fullName: 'Rohan Mehta', email: 'rohan@outlook.com', city: 'Mumbai', organisation: 'NMIMS' }),
        answers: sales(),
      }),
    );
    expect((await service.list({ opportunity: 'sales_internship' }, { limit: 50, offset: 0 })).items.map((a) => a.fullName)).toEqual([
      'Rohan Mehta',
    ]);
    expect((await service.list({ search: 'mumbai' }, { limit: 50, offset: 0 })).total).toBe(1);
    expect((await service.list({ search: 'Arts & Commerce' }, { limit: 50, offset: 0 })).total).toBe(1);
    expect((await service.list({ search: 'AANYA.SHARMA' }, { limit: 50, offset: 0 })).total).toBe(1);
    expect((await service.list({ status: 'shortlisted' }, { limit: 50, offset: 0 })).total).toBe(0);

    const counts = await service.counts();
    expect(counts).toHaveLength(12);
    expect(counts.find((c) => c.opportunity === 'campus_ambassador' && c.status === 'new')?.count).toBe(1);
  });

  it('a status move is recorded with who and when; the same status again is no move', async () => {
    const staff = await makeStaff('team@getpl4y.com');
    const a = await stored((await submit(input())).reference);
    clock = new Date('2026-10-29T09:00:00Z');
    const moved = await service.setStatus(staff, a.id, 'shortlisted');
    expect(moved.status).toBe('shortlisted');
    expect(moved.statusChangedAt.toISOString()).toBe('2026-10-29T09:00:00.000Z');
    await service.setStatus(staff, a.id, 'shortlisted');
    const history = await service.history(a.id);
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.byUserId])).toEqual([
      [null, 'new', null],
      ['new', 'shortlisted', staff.userId],
    ]);
  });

  it('notes are kept, newest first; an empty note is refused', async () => {
    const staff = await makeStaff('team@getpl4y.com');
    const a = await stored((await submit(input())).reference);
    await service.addNote(staff, a.id, 'Strong reach.');
    await service.addNote(staff, a.id, '  Call on Friday.  ');
    expect((await service.notes(a.id)).map((n) => n.body)).toEqual(['Call on Friday.', 'Strong reach.']);
    expect((await refused(() => service.addNote(staff, a.id, '  '))).code).toBe(CareerCode.INVALID_NOTE);
  });

  it('shows other applications from the same email', async () => {
    const first = await stored((await submit(input())).reference);
    await submit(input({ opportunity: 'sales_internship', answers: sales() }));
    expect((await service.others(first)).map((o) => o.opportunity)).toEqual(['sales_internship']);
  });
});

describe('careers R8 — retention', () => {
  it('deletes applications (and resumes) a year past their last status change, and nothing newer', async () => {
    const token = randomUUID();
    const id = `pl4y/careers/${token}/${newId()}.pdf`;
    files.stored.set(id, 1000);
    const old = await stored((await submit(input({ clientToken: token, resume: { publicId: id, name: 'cv.pdf' } }))).reference);
    const staff = await makeStaff('team@getpl4y.com');
    await service.setStatus(staff, old.id, 'rejected');
    await service.addNote(staff, old.id, 'Not this time.');

    clock = new Date(clock.getTime() + 200 * 86_400_000);
    const fresh = await stored((await submit(input())).reference);

    clock = new Date(new Date('2026-10-28T06:00:00Z').getTime() + (RETENTION_DAYS + 1) * 86_400_000);
    expect(await service.purge()).toBe(1);
    expect(await service.byId(old.id)).toBeNull();
    expect(await prisma.careerNote.count()).toBe(0);
    expect(files.destroyed).toEqual([id]);
    expect(await service.byId(fresh.id)).not.toBeNull();
  });
});
