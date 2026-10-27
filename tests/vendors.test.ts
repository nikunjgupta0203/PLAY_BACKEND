/**
 * vendors — service tests against a real Postgres (conventions.md §5).
 *
 * Every numbered rule has a test that names it, so `grep 'vendors R3'` finds it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import {
  createVendorService,
  VendorCode,
  type SubmitInput,
  type VendorApplication,
  type VendorService,
} from '../src/modules/vendors/service/index.js';
import { AnswerCode } from '../src/modules/partnerships/service/answers.js';
import type { Db } from '../src/platform/db.js';
import { isUserError, type UserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createRateLimiter } from '../src/platform/rateLimit.js';

let prisma: PrismaClient;
let service: VendorService;

const mail = {
  confirmations: [] as VendorApplication[],
  team: [] as VendorApplication[],
  failConfirmation: false,
  reset() {
    this.confirmations = [];
    this.team = [];
    this.failConfirmation = false;
  },
};

let ipCounter = 0;
let ip = '';

const seller = (over: Record<string, unknown> = {}) => ({
  sellerType: 'brand',
  storeName: '  Smashpoint   Sports ',
  contactName: 'Ravi Mehta',
  whatsapp: '+91 98765 43210',
  email: ' Ravi@Smashpoint.in ',
  city: 'Pune',
  web: '@smashpoint',
  ...over,
});

const products = (over: Record<string, unknown> = {}) => ({
  sports: ['pickleball', 'padel'],
  productCount: '21_100',
  priceMin: '499',
  priceMax: '18,000',
  inventory: 'ready',
  catalogLink: 'drive.google.com/smashpoint',
  ...over,
});

const fulfilment = (over: Record<string, unknown> = {}) => ({
  dispatchTime: 'within_48h',
  packaging: 'ready',
  channels: ['own_website', 'amazon'],
  gstStatus: 'not_registered',
  commercialModel: 'commission',
  ...over,
});

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  clientToken: randomUUID(),
  seller: seller(),
  products: products(),
  fulfilment: fulfilment(),
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
  const row = await prisma.vendorApplication.findUnique({ where: { reference } });
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
  service = createVendorService({
    db,
    limiter: createRateLimiter(db),
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
  ip = `198.51.100.${++ipCounter}`;
});

describe('vendors R1, R2 — the form, stored', () => {
  it('a brand submits; answers are cleaned and the application starts NEW', async () => {
    const receipt = await submit(input());
    expect(receipt.reference).toMatch(/^SHOP-[A-HJ-NP-Z2-9]{6}$/);
    expect(receipt.storeName).toBe('Smashpoint Sports');

    const a = await stored(receipt.reference);
    expect(a.status).toBe('new');
    expect(a.contactEmail).toBe('ravi@smashpoint.in');
    expect(a.sports).toEqual(['pickleball', 'padel']);
    expect(a.products).toMatchObject({ priceMin: 499, priceMax: 18000, catalogLink: 'https://drive.google.com/smashpoint' });
    expect(a.gstStatus).toBe('not_registered');
    expect(await service.history(a.id)).toMatchObject([{ fromStatus: null, toStatus: 'new', byUserId: null }]);
  });

  it('a store name is required except for an individual', async () => {
    const e = await refused(() => submit(input({ seller: seller({ storeName: '' }) })));
    expect(e.code).toBe(AnswerCode.ANSWER_REQUIRED);
    expect(e.details?.field).toBe('seller.storeName');

    const r = await submit(input({ seller: seller({ sellerType: 'individual', storeName: '' }) }));
    expect(r.storeName).toBe('Ravi Mehta');
  });

  it('make time is asked only for made-to-order or mixed stock', async () => {
    const e = await refused(() => submit(input({ products: products({ inventory: 'mixed' }) })));
    expect(e.details?.field).toBe('products.makeTime');

    const r = await submit(input({ products: products({ inventory: 'ready', makeTime: '1_2_weeks' }) }));
    expect((await stored(r.reference)).products.makeTime).toBeUndefined();
  });

  it('the highest price is not below the lowest', async () => {
    const e = await refused(() => submit(input({ products: products({ priceMin: 5000, priceMax: 100 }) })));
    expect(e.code).toBe(AnswerCode.INVALID_ANSWER);
    expect(e.details?.field).toBe('products.priceMax');
  });

  it('a GSTIN is checked only when registered, and stored upper-case', async () => {
    const bad = await refused(() => submit(input({ fulfilment: fulfilment({ gstStatus: 'registered', gstin: 'ABC' }) })));
    expect(bad.details?.field).toBe('fulfilment.gstin');

    const r = await submit(input({ fulfilment: fulfilment({ gstStatus: 'registered', gstin: '27aapfu0939f1zv' }) }));
    expect((await stored(r.reference)).fulfilment.gstin).toBe('27AAPFU0939F1ZV');

    const dropped = await submit(input({ fulfilment: fulfilment({ gstStatus: 'applied', gstin: 'nonsense' }) }));
    expect((await stored(dropped.reference)).fulfilment.gstin).toBeUndefined();
  });

  it('nothing is stored without the consent', async () => {
    const e = await refused(() => submit(input({ consent: false })));
    expect(e.code).toBe(VendorCode.CONSENT_REQUIRED);
    expect(await prisma.vendorApplication.count()).toBe(0);
  });
});

describe('vendors R3 — one application per attempt', () => {
  it('submitting the same attempt twice returns the first', async () => {
    const i = input();
    const [a, b] = await Promise.all([submit(i), submit(i)]);
    expect(a.reference).toBe(b.reference);
    expect(await prisma.vendorApplication.count()).toBe(1);
  });
});

describe('vendors R4 — emails never lose the application', () => {
  it('a failed confirmation is recorded; the team still hears', async () => {
    mail.failConfirmation = true;
    const r = await submit(input());
    expect((await stored(r.reference)).confirmationEmail).toBe('failed');
    expect(mail.team).toHaveLength(1);
  });
});

describe('vendors R5 — bots and floods', () => {
  it('a filled hidden field gets a receipt and stores nothing', async () => {
    const r = await submit(input({ trap: 'http://spam' }));
    expect(r.reference).toMatch(/^SHOP-/);
    expect(await prisma.vendorApplication.count()).toBe(0);
  });

  it('the sixth application from one email in a day is refused', async () => {
    for (let n = 0; n < 5; n++) {
      ip = `198.51.101.${n}`;
      await submit(input());
    }
    ip = '198.51.101.99';
    const e = await refused(() => submit(input()));
    expect(e.code).toBe(VendorCode.VENDOR_THROTTLED);
  });
});

describe('vendors R6 — the portal', () => {
  it('staff move it through the statuses, each move recorded', async () => {
    const staff = await makeStaff('ops@getpl4y.com');
    const r = await submit(input());
    const a = await stored(r.reference);

    await service.setStatus(staff, a.id, 'reviewing');
    await service.setStatus(staff, a.id, 'reviewing');
    await service.setStatus(staff, a.id, 'more_info_needed');
    const done = await service.setStatus(staff, a.id, 'approved');
    expect(done.status).toBe('approved');
    expect((await service.history(a.id)).map((h) => h.toStatus)).toEqual(['new', 'reviewing', 'more_info_needed', 'approved']);

    const counts = await service.counts();
    expect(counts).toMatchObject({ new: 0, approved: 1 });
  });

  it('notes are kept; an empty one is refused', async () => {
    const staff = await makeStaff('ops2@getpl4y.com');
    const a = await stored((await submit(input())).reference);
    await service.addNote(staff, a.id, '  Asked for a price list on WhatsApp. ');
    expect((await service.notes(a.id))[0]?.body).toBe('Asked for a price list on WhatsApp.');
    expect((await refused(() => service.addNote(staff, a.id, '   '))).code).toBe(VendorCode.INVALID_NOTE);
  });

  it('search, status and sport filters', async () => {
    await submit(input());
    await submit(input({ seller: seller({ storeName: 'Boundary Bats', email: 'b@bats.in', city: 'Mumbai' }), products: products({ sports: ['cricket'] }) }));

    expect((await service.list({ search: 'bound' }, { limit: 10, offset: 0 })).total).toBe(1);
    expect((await service.list({ sport: 'padel' }, { limit: 10, offset: 0 })).items[0]?.storeName).toBe('Smashpoint Sports');
    expect((await service.list({ status: 'new' }, { limit: 10, offset: 0 })).total).toBe(2);
    expect(await service.cities()).toEqual(['Mumbai', 'Pune']);
  });
});
