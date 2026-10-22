/**
 * partnerships — service tests against a real Postgres (conventions.md §5).
 *
 * One application per attempt is a unique index, and the consents are a CHECK:
 * a mock would agree with whatever the test hoped. The scenarios follow the
 * spec's test list (Google Doc "PL4Y Partnership Forms", §15).
 *
 * Every numbered rule has a test that names it, so `grep 'partnerships R3'`
 * finds it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import {
  createPartnershipService,
  PartnershipCode,
  type PartnershipApplication,
  type PartnershipService,
  type SubmitInput,
} from '../src/modules/partnerships/service/index.js';
import { AnswerCode, flatten, read } from '../src/modules/partnerships/service/answers.js';
import { SECTIONS } from '../src/modules/partnerships/service/form.js';
import type { Db } from '../src/platform/db.js';
import { isUserError, type UserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createRateLimiter } from '../src/platform/rateLimit.js';

let prisma: PrismaClient;
let service: PartnershipService;

/** What the emails would have done. `failConfirmation` makes the applicant's one fail. */
const mail = {
  confirmations: [] as PartnershipApplication[],
  team: [] as PartnershipApplication[],
  failConfirmation: false,
  reset() {
    this.confirmations = [];
    this.team = [];
    this.failConfirmation = false;
  },
};

const root = (token: string) => `pl4y/partners/${token}`;
let ipCounter = 0;
/** A fresh IP per test, so the per-IP limits only bite where a test means them to. */
let ip = '';

const basic = (over: Record<string, unknown> = {}) => ({
  applicantType: 'club',
  organisationName: '  Koramangala   Runners ',
  description: 'A running club with Sunday long runs.',
  instagram: '@kramrunners',
  city: 'Bengaluru',
  state: 'Karnataka',
  contactName: 'Asha Rao',
  email: ' Asha@Example.com ',
  phone: '+91 98765 43210',
  preferredContact: 'whatsapp',
  ...over,
});

const community = (over: Record<string, unknown> = {}) => ({
  sports: ['running'],
  totalMembers: '1,200',
  hasUpcoming: false,
  interests: ['discovery', 'publish'],
  ...over,
});

const venue = (locations: Record<string, unknown>[]) => ({
  businessName: 'Smash Arenas',
  locations,
  interests: ['listing'],
});

const location = (n: number, token: string) => ({
  name: `Smash Arena ${n}`,
  address: `${n}, 100 Feet Road`,
  city: 'Bengaluru',
  sports: ['pickleball', 'badminton'],
  courts: 4,
  photos: [`${root(token)}/photo-${n}`],
});

const events = (list: Record<string, unknown>[]) => ({
  organiserName: 'Smash Events',
  sports: ['pickleball'],
  hasUpcoming: list.length > 0,
  events: list,
  interests: ['publish', 'registrations'],
});

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  clientToken: randomUUID(),
  profile: basic(),
  categories: ['community'],
  sections: { community: community() },
  consentAccurate: true,
  consentContact: true,
  consentPublish: false,
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
  const row = await prisma.partnershipApplication.findUnique({ where: { reference } });
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
  service = createPartnershipService({
    db,
    limiter: createRateLimiter(db),
    media: {
      root,
      signUpload: ({ publicId, folder }) => ({
        cloudName: 'test',
        apiKey: 'key',
        timestamp: 1,
        publicId,
        folder,
        uploadPreset: 'preset',
        signature: 'sig',
        uploadUrl: 'https://upload.test',
        expiresAt: new Date(0),
      }),
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
  ip = `203.0.113.${++ipCounter}`;
});

describe('partnerships R1 — one application, every category picked', () => {
  it('test 1: a running club picks only Sports Club / Community and submits', async () => {
    const receipt = await submit(input());
    expect(receipt.reference).toMatch(/^P4Y-[A-HJ-NP-Z2-9]{6}$/);
    expect(receipt.organisationName).toBe('Koramangala Runners');
    expect(receipt.categories).toEqual(['community']);

    const a = await stored(receipt.reference);
    expect(a.status).toBe('submitted');
    expect(a.contactEmail).toBe('asha@example.com');
    expect(a.sections.community).toMatchObject({ sports: ['running'], totalMembers: 1200, hasUpcoming: false });
    expect(await service.history(a.id)).toMatchObject([{ fromStatus: null, toStatus: 'submitted', byUserId: null }]);
  });

  it('test 2: a company sends a venue and an events section in one application', async () => {
    const token = randomUUID();
    const receipt = await submit(
      input({
        clientToken: token,
        profile: basic({ applicantType: 'company', organisationName: 'Smash Sports Pvt Ltd' }),
        categories: ['events', 'venue'],
        sections: {
          venue: venue([location(1, token)]),
          events: events([{ name: 'Smash Open', registrationCloses: '2026-12-01' }]),
        },
      }),
    );
    expect(await prisma.partnershipApplication.count()).toBe(1);
    const a = await stored(receipt.reference);
    // In the form's order, whatever order they came in.
    expect(a.categories).toEqual(['venue', 'events']);
    expect(Object.keys(a.sections).sort()).toEqual(['events', 'venue']);
  });

  it('test 3: a college sends its college and its club sections', async () => {
    const receipt = await submit(
      input({
        profile: basic({ applicantType: 'college', organisationName: 'RV College' }),
        categories: ['college', 'community'],
        sections: { college: { institutionName: 'RV College', interests: ['introduce'] }, community: community() },
      }),
    );
    expect((await stored(receipt.reference)).categories).toEqual(['community', 'college']);
  });

  it('test 4: a venue operator adds several locations, with photos', async () => {
    const token = randomUUID();
    const receipt = await submit(
      input({
        clientToken: token,
        categories: ['venue'],
        sections: { venue: venue([location(1, token), location(2, token), location(3, token)]) },
      }),
    );
    const a = await stored(receipt.reference);
    expect((a.sections.venue!.locations as unknown[]).length).toBe(3);
    const lines = flatten(read(SECTIONS.venue, a.sections.venue!));
    expect(lines).toContain('  3.');
    expect(lines).toContain('    Photos: 1 image');
  });

  it('test 5: an event organiser adds several upcoming events', async () => {
    const list = [1, 2, 3, 4].map((n) => ({ name: `Event ${n}`, capacity: 64 }));
    const receipt = await submit(input({ categories: ['events'], sections: { events: events(list) } }));
    expect(((await stored(receipt.reference)).sections.events!.events as unknown[]).length).toBe(4);
  });

  it('test 6: answers kept for a category since dropped are not sent on', async () => {
    const receipt = await submit(
      input({ categories: ['brand'], sections: { community: community(), brand: { brandName: 'Fizz', objectives: 'Reach runners' } } }),
    );
    const a = await stored(receipt.reference);
    expect(a.categories).toEqual(['brand']);
    expect(a.sections).toEqual({ brand: { brandName: 'Fizz', objectives: 'Reach runners' } });
  });

  it('refuses no category, or one PL4Y does not offer', async () => {
    expect((await refused(() => submit(input({ categories: [] })))).code).toBe(PartnershipCode.INVALID_CATEGORIES);
    expect((await refused(() => submit(input({ categories: ['community', 'sponsor'] })))).code).toBe(PartnershipCode.INVALID_CATEGORIES);
  });
});

describe('partnerships R2 — answers are checked against the form', () => {
  it('test 7: a missing required answer names its question', async () => {
    const e = await refused(() => submit(input({ profile: basic({ email: '' }) })));
    expect(e.code).toBe(AnswerCode.ANSWER_REQUIRED);
    expect(e.details?.field).toBe('basic.email');

    const token = randomUUID();
    const inLocation = await refused(() =>
      submit(input({ clientToken: token, categories: ['venue'], sections: { venue: venue([location(1, token), { name: 'No address' }]) } })),
    );
    expect(inLocation.details?.field).toBe('venue.locations.1.address');
  });

  it('an organisation name is required, except from an individual', async () => {
    expect((await refused(() => submit(input({ profile: basic({ organisationName: ' ' }) })))).details?.field).toBe('basic.organisationName');
    const receipt = await submit(input({ profile: basic({ applicantType: 'individual', organisationName: '' }) }));
    expect(receipt.organisationName).toBe('Asha Rao');
  });

  it('upcoming events are asked for only when there are some', async () => {
    const e = await refused(() => submit(input({ categories: ['events'], sections: { events: { ...events([]), hasUpcoming: true } } })));
    expect(e.details?.field).toBe('events.events');
    // "No upcoming events": a list sent anyway is dropped.
    const receipt = await submit(
      input({ categories: ['events'], sections: { events: { ...events([{ name: 'Stale' }]), hasUpcoming: false } } }),
    );
    expect((await stored(receipt.reference)).sections.events!.events).toBeUndefined();
  });

  it('refuses an option that is not offered, a bad email, phone or link', async () => {
    expect((await refused(() => submit(input({ profile: basic({ state: 'Atlantis' }) })))).code).toBe(AnswerCode.INVALID_ANSWER);
    expect((await refused(() => submit(input({ profile: basic({ email: 'asha@' }) })))).details?.field).toBe('basic.email');
    expect((await refused(() => submit(input({ profile: basic({ phone: '12345' }) })))).details?.field).toBe('basic.phone');
    expect((await refused(() => submit(input({ profile: basic({ website: 'javascript:alert(1)' }) })))).details?.field).toBe('basic.website');
  });

  it('a link without its scheme is given https://; unknown keys are dropped', async () => {
    const receipt = await submit(input({ profile: basic({ website: 'kramrunners.in', isAdmin: true }) }));
    const a = await stored(receipt.reference);
    expect(a.profile.website).toBe('https://kramrunners.in/');
    expect(a.profile).not.toHaveProperty('isAdmin');
  });

  it('an image must be one uploaded for this attempt (ADR 0003 §C2)', async () => {
    const token = randomUUID();
    const someoneElses = `${root(randomUUID())}/logo`;
    const e = await refused(() => submit(input({ clientToken: token, profile: basic({ logo: someoneElses }) })));
    expect(e.details?.field).toBe('basic.logo');
    const receipt = await submit(input({ clientToken: token, profile: basic({ logo: `${root(token)}/logo` }) }));
    expect((await stored(receipt.reference)).profile.logo).toBe(`${root(token)}/logo`);
  });

  it('refuses without both required consents; publishing is a separate, optional one', async () => {
    expect((await refused(() => submit(input({ consentContact: false })))).code).toBe(PartnershipCode.CONSENT_REQUIRED);
    expect((await refused(() => submit(input({ consentAccurate: false })))).code).toBe(PartnershipCode.CONSENT_REQUIRED);
    const a = await stored((await submit(input({ consentPublish: true }))).reference);
    expect(a.consentPublish).toBe(true);
    expect(await prisma.partnershipApplication.count()).toBe(1);
  });
});

describe('partnerships R3 — one attempt, one application', () => {
  it('test 11: repeated taps on Submit store one application', async () => {
    const i = input();
    const receipts = await Promise.all([submit(i), submit(i), submit(i), submit(i)]);
    expect(new Set(receipts.map((r) => r.reference)).size).toBe(1);
    expect(await prisma.partnershipApplication.count()).toBe(1);
    expect(mail.confirmations).toHaveLength(1);
  });

  it('a retry after the first went through returns the same reference', async () => {
    const i = input();
    const first = await submit(i);
    expect((await submit(i)).reference).toBe(first.reference);
  });

  it('refuses an attempt id that is not a UUID', async () => {
    expect((await refused(() => submit(input({ clientToken: 'abc' })))).code).toBe(PartnershipCode.INVALID_TOKEN);
  });
});

describe('partnerships R4 — the emails never cost an application', () => {
  it('emails the applicant and the team', async () => {
    await submit(input());
    expect(mail.confirmations).toHaveLength(1);
    expect(mail.team).toHaveLength(1);
    expect((await prisma.partnershipApplication.findFirst())!.confirmationEmail).toBe('sent');
  });

  it('test 8: the confirmation fails, and the application is still stored', async () => {
    mail.failConfirmation = true;
    const receipt = await submit(input());
    const a = await stored(receipt.reference);
    expect(a.confirmationEmail).toBe('failed');
    expect(mail.team).toHaveLength(1);
  });
});

describe('partnerships R5 — spam', () => {
  it('a filled hidden field looks sent but stores nothing', async () => {
    const receipt = await submit(input({ trap: 'http://spam.example' }));
    expect(receipt.reference).toMatch(/^P4Y-/);
    expect(await prisma.partnershipApplication.count()).toBe(0);
    expect(mail.confirmations).toHaveLength(0);
  });

  it('limits applications per email', async () => {
    for (let n = 0; n < 5; n++) await submit(input());
    const e = await refused(() => submit(input()));
    expect(e.code).toBe(PartnershipCode.PARTNERSHIP_THROTTLED);
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('signs uploads into the attempt’s own folder', async () => {
    const token = randomUUID();
    const signed = await service.uploadSignature(token, { ip });
    expect(signed.folder).toBe(root(token));
    expect((await refused(() => service.uploadSignature('nope', { ip }))).code).toBe(PartnershipCode.INVALID_TOKEN);
  });
});

describe('partnerships R6 — the portal', () => {
  it('test 12: search, filter, move on, note, verify, assign, export', async () => {
    const staff = await makeStaff('ops@pl4y.test');
    const club = await stored((await submit(input())).reference);
    const token = randomUUID();
    const company = await stored(
      (
        await submit(
          input({
            clientToken: token,
            profile: basic({ applicantType: 'company', organisationName: 'Smash Sports', email: 'hi@smash.in', phone: '+91 90000 00000', city: 'Mumbai', state: 'Maharashtra' }),
            categories: ['venue', 'events'],
            sections: { venue: venue([location(1, token)]), events: events([]) },
          }),
        )
      ).reference,
    );

    const page = { limit: 50, offset: 0 };
    expect((await service.list({}, page)).total).toBe(2);
    expect((await service.list({ search: 'smash' }, page)).items.map((a) => a.id)).toEqual([company.id]);
    expect((await service.list({ search: club.reference.toLowerCase() }, page)).items.map((a) => a.id)).toEqual([club.id]);
    expect((await service.list({ category: 'events' }, page)).items.map((a) => a.id)).toEqual([company.id]);
    expect((await service.list({ city: 'bengaluru' }, page)).items.map((a) => a.id)).toEqual([club.id]);
    expect(await service.cities()).toEqual(['Bengaluru', 'Mumbai']);

    await service.setStatus(staff, club.id, 'contacted');
    expect((await service.list({ status: 'contacted' }, page)).items.map((a) => a.id)).toEqual([club.id]);
    expect((await service.counts()).contacted).toBe(1);
    expect((await service.history(club.id)).map((h) => [h.fromStatus, h.toStatus, h.byUserId])).toEqual([
      [null, 'submitted', null],
      ['submitted', 'contacted', staff.userId],
    ]);

    await service.addNote(staff, club.id, '  Called Asha, follow up next week. ');
    expect((await service.notes(club.id)).map((n) => n.body)).toEqual(['Called Asha, follow up next week.']);
    expect((await refused(() => service.addNote(staff, club.id, '   '))).code).toBe(PartnershipCode.INVALID_NOTE);

    const updated = await service.update(staff, club.id, { verified: true, assignedTo: staff.userId, followUpOn: '2026-11-01' });
    expect(updated.verifiedBy).toBe(staff.userId);
    expect(updated.assignedTo).toBe(staff.userId);
    expect(updated.followUpOn).toBe('2026-11-01');
    const cleared = await service.update(staff, club.id, { verified: false, followUpOn: null });
    expect([cleared.verifiedAt, cleared.followUpOn, cleared.assignedTo]).toEqual([null, null, staff.userId]);

    expect((await service.exportRows({ category: 'venue' })).map((a) => a.id)).toEqual([company.id]);
  });

  it('assigns to PL4Y staff only', async () => {
    const a = await stored((await submit(input())).reference);
    const staff = await makeStaff('ops@pl4y.test');
    const player = newId();
    await prisma.user.create({ data: { id: player, email: 'player@pl4y.test', displayName: 'player' } });
    expect((await refused(() => service.update(staff, a.id, { assignedTo: player }))).code).toBe(PartnershipCode.INVALID_ASSIGNEE);
  });
});

describe('partnerships R7 — the same organisation, again', () => {
  it('flags look-alikes and links them, keeping both', async () => {
    const staff = await makeStaff('ops@pl4y.test');
    const first = await stored((await submit(input())).reference);
    const again = await stored((await submit(input({ profile: basic({ email: 'other@example.com' }) }))).reference);
    const unrelated = await stored(
      (await submit(input({ profile: basic({ organisationName: 'Other Club', email: 'x@y.in', phone: '+91 91111 11111' }) }))).reference,
    );

    expect((await service.possibleDuplicates(again)).map((a) => a.id)).toEqual([first.id]);
    expect(await service.possibleDuplicates(unrelated)).toEqual([]);

    await service.update(staff, again.id, { linkedApplicationId: first.id });
    expect((await service.linked(first)).map((a) => a.id)).toEqual([again.id]);
    expect((await service.linked((await service.byId(again.id))!)).map((a) => a.id)).toEqual([first.id]);
    expect(await prisma.partnershipApplication.count()).toBe(3);

    expect((await refused(() => service.update(staff, again.id, { linkedApplicationId: again.id }))).code).toBe(PartnershipCode.INVALID_LINK);
  });
});
