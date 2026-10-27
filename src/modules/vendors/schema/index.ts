/**
 * vendors — GraphQL surface (docs/modules/23-vendors.md).
 *
 * One public field, for the form: submit. Nobody signs in. Everything else is
 * the portal's: PL4Y staff read every application; admin and support work on them.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { isUserError } from '../../../platform/errors/index.js';
import { identity } from '../../identity/index.js';
import { flatten, read, type Answer } from '../../partnerships/index.js';
import {
  displayName,
  FULFILMENT,
  PRODUCTS,
  SELLER,
  SELLER_TYPE_TITLES,
  SELLER_TYPES,
  SPORTS,
  STEP_TITLES,
  VENDOR_STATUSES,
  vendors,
} from '../index.js';
import type { Filter, Receipt, SellerType, Sport, StatusChange, VendorApplication, VendorNote, VendorStatus } from '../index.js';

const upper = <T extends string>(values: readonly T[]) =>
  Object.fromEntries(values.map((v) => [v.toUpperCase(), { value: v }])) as Record<string, { value: T }>;

const StatusEnum = builder.enumType('VendorStatus', {
  description: 'vendors R6 — where PL4Y is with a shop seller application. Submitting makes it NEW.',
  values: upper<VendorStatus>(VENDOR_STATUSES),
});

const SellerTypeEnum = builder.enumType('VendorSellerType', { values: upper<SellerType>(SELLER_TYPES) });

const SportEnum = builder.enumType('VendorSport', { values: upper<Sport>(SPORTS.map(([k]) => k)) });

// --- the form -------------------------------------------------------------------------------

const ReceiptRef = builder.objectRef<Receipt>('VendorReceipt').implement({
  description: 'vendors R3 — what the seller is shown once their application is stored.',
  fields: (t) => ({
    reference: t.exposeString('reference'),
    storeName: t.exposeString('storeName'),
    submittedAt: t.field({ type: 'DateTime', resolve: (r) => r.submittedAt }),
  }),
});

interface FormErrorShape extends UserErrorShape {
  field: string | null;
}

const FormErrorRef = builder.objectRef<FormErrorShape>('VendorFormError').implement({
  description: 'A user error that may name the question it is about.',
  fields: (t) => ({
    code: t.exposeString('code'),
    message: t.exposeString('message'),
    field: t.string({ nullable: true, description: 'The question, as `step.key`: `seller.email`, `fulfilment.gstin`.', resolve: (e) => e.field }),
    retryAfterSeconds: t.int({ nullable: true, resolve: (e) => e.retryAfterSeconds ?? null }),
  }),
});

const SubmitPayload = builder
  .objectRef<{ receipt: Receipt | null; userError: FormErrorShape | null }>('SubmitVendorApplicationPayload')
  .implement({
    fields: (t) => ({
      receipt: t.field({ type: ReceiptRef, nullable: true, resolve: (p) => p.receipt }),
      userError: t.field({ type: FormErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const SubmitInput = builder.inputType('SubmitVendorApplicationInput', {
  fields: (t) => ({
    clientToken: t.id({ required: true, description: 'R3 — a UUID the form makes once per attempt.' }),
    seller: t.field({ type: 'JSONObject', required: true, description: 'Step 1 answers, by key (R2).' }),
    products: t.field({ type: 'JSONObject', required: true, description: 'Step 2 answers, by key.' }),
    fulfilment: t.field({ type: 'JSONObject', required: true, description: 'Step 3 answers, by key.' }),
    consent: t.boolean({ required: true }),
    trap: t.string({ description: 'R5 — the hidden field. Left empty by people.' }),
  }),
});

builder.mutationFields((t) => ({
  submitVendorApplication: t.field({
    type: SubmitPayload,
    description: 'vendors R1–R5 — the PL4Y Shop vendor form, sent. No sign-in. Emails the seller and tells the team.',
    args: { input: t.arg({ type: SubmitInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const i = args.input;
      try {
        const receipt = await vendors.submit(
          {
            clientToken: String(i.clientToken),
            seller: i.seller,
            products: i.products,
            fulfilment: i.fulfilment,
            consent: i.consent,
            trap: i.trap ?? null,
          },
          { ip: ctx.ip },
        );
        return { receipt, userError: null };
      } catch (e) {
        if (!isUserError(e)) throw e;
        const field = typeof e.details?.field === 'string' ? e.details.field : null;
        return { receipt: null, userError: { code: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds ?? null, field } };
      }
    },
  }),
}));

// --- the portal -----------------------------------------------------------------------------

const AnswerRef = builder.objectRef<Answer>('VendorAnswer').implement({
  description: 'One question as the seller answered it. Unanswered questions are left out.',
  fields: (t) => ({
    key: t.exposeString('key'),
    label: t.exposeString('label'),
    text: t.string({ nullable: true, resolve: (a) => a.text }),
  }),
});

const SectionRef = builder.objectRef<{ title: string; answers: Answer[] }>('VendorSection').implement({
  fields: (t) => ({
    title: t.exposeString('title'),
    answers: t.field({ type: [AnswerRef], resolve: (s) => s.answers }),
  }),
});

const sections = (a: VendorApplication) => [
  { title: STEP_TITLES.seller, answers: read(SELLER, a.seller) },
  { title: STEP_TITLES.products, answers: read(PRODUCTS, a.products) },
  { title: STEP_TITLES.fulfilment, answers: read(FULFILMENT, a.fulfilment) },
];

const StaffRef = builder.objectRef<{ id: string; displayName: string }>('VendorStaff').implement({
  fields: (t) => ({ id: t.exposeID('id'), displayName: t.exposeString('displayName') }),
});

const person = async (id: string | null) => (id ? ((await identity.usersByIds([id]))[0] ?? null) : null);

const NoteRef = builder.objectRef<VendorNote>('VendorNote').implement({
  description: 'R6 — staff only. Never shown to the seller.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    author: t.field({ type: StaffRef, nullable: true, resolve: (n) => person(n.authorId) }),
    createdAt: t.field({ type: 'DateTime', resolve: (n) => n.createdAt }),
  }),
});

const StatusChangeRef = builder.objectRef<StatusChange>('VendorStatusChange').implement({
  fields: (t) => ({
    from: t.field({ type: StatusEnum, nullable: true, resolve: (c) => c.fromStatus }),
    to: t.field({ type: StatusEnum, resolve: (c) => c.toStatus }),
    by: t.field({ type: StaffRef, nullable: true, description: 'Null for the submission itself.', resolve: (c) => person(c.byUserId) }),
    at: t.field({ type: 'DateTime', resolve: (c) => c.createdAt }),
  }),
});

const option = (list: readonly (readonly [string, string])[], v: string) => list.find(([k]) => k === v)?.[1] ?? v;
const fieldOptions = (key: string) => FULFILMENT.find((f) => f.key === key)?.options ?? [];

/** "Padel, Other (Archery)" — the list in words, with the seller's own "other" text. */
function sportsLabel(a: VendorApplication): string {
  const other = typeof a.products.sportsOther === 'string' ? a.products.sportsOther : '';
  return a.sports.map((s) => (s === 'other' && other ? `Other (${other})` : option(SPORTS, s))).join(', ');
}

const ApplicationRef = builder.objectRef<VendorApplication>('VendorApplication').implement({
  description: 'vendors R1 — one submission of the PL4Y Shop vendor form.',
  fields: (t) => ({
    id: t.exposeID('id'),
    reference: t.exposeString('reference'),
    sellerType: t.field({ type: SellerTypeEnum, resolve: (a) => a.sellerType }),
    sellerTypeLabel: t.string({ resolve: (a) => SELLER_TYPE_TITLES[a.sellerType] }),
    storeName: t.string({ nullable: true, resolve: (a) => a.storeName }),
    displayName: t.string({ description: 'The store, or the person for an individual.', resolve: (a) => displayName(a) }),
    contactName: t.exposeString('contactName'),
    contactEmail: t.exposeString('contactEmail'),
    contactPhone: t.exposeString('contactPhone', { description: 'WhatsApp number.' }),
    city: t.exposeString('city'),
    sports: t.field({ type: [SportEnum], resolve: (a) => a.sports }),
    sportsLabel: t.string({ description: 'In words; "Other" carries what the seller typed.', resolve: (a) => sportsLabel(a) }),
    gstStatus: t.string({ description: 'In words.', resolve: (a) => option(fieldOptions('gstStatus'), a.gstStatus) }),
    commercialModel: t.string({ description: 'In words.', resolve: (a) => option(fieldOptions('commercialModel'), a.commercialModel) }),
    sections: t.field({ type: [SectionRef], description: 'Seller, products, fulfilment — as answered.', resolve: sections }),
    consentedAt: t.field({ type: 'DateTime', resolve: (a) => a.consentedAt }),
    status: t.field({ type: StatusEnum, resolve: (a) => a.status }),
    confirmationEmail: t.string({ description: 'pending, sent or failed (R4).', resolve: (a) => a.confirmationEmail }),
    notes: t.field({ type: [NoteRef], description: 'Newest first.', resolve: (a) => vendors.notes(a.id) }),
    history: t.field({ type: [StatusChangeRef], description: 'Oldest first.', resolve: (a) => vendors.history(a.id) }),
    createdAt: t.field({ type: 'DateTime', resolve: (a) => a.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (a) => a.updatedAt }),
  }),
});

const PageRef = builder.objectRef<{ total: number; items: VendorApplication[] }>('VendorApplicationPage').implement({
  fields: (t) => ({
    total: t.exposeInt('total'),
    items: t.field({ type: [ApplicationRef], resolve: (p) => p.items }),
  }),
});

const CountRef = builder.objectRef<{ status: VendorStatus; count: number }>('VendorStatusCount').implement({
  fields: (t) => ({
    status: t.field({ type: StatusEnum, resolve: (c) => c.status }),
    count: t.exposeInt('count'),
  }),
});

const FilterInput = builder.inputType('VendorFilterInput', {
  fields: (t) => ({
    search: t.string({ description: 'Store, contact name, email, phone or reference.' }),
    status: t.field({ type: StatusEnum }),
    sport: t.field({ type: SportEnum }),
    city: t.string(),
  }),
});

const toFilter = (f: { search?: string | null; status?: VendorStatus | null; sport?: Sport | null; city?: string | null } | null | undefined): Filter => ({
  search: f?.search ?? null,
  status: f?.status ?? null,
  sport: f?.sport ?? null,
  city: f?.city ?? null,
});

/** A cell a spreadsheet will not run as a formula. */
function cell(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: VendorApplication[]): string {
  const head = ['Reference', 'Submitted', 'Status', 'Store', 'Seller type', 'Contact', 'Email', 'WhatsApp', 'City', 'Sports', 'GST', 'Model', 'Products', 'Fulfilment'];
  const lines = rows.map((a) => [
    a.reference,
    a.createdAt.toISOString(),
    a.status,
    displayName(a),
    SELLER_TYPE_TITLES[a.sellerType],
    a.contactName,
    a.contactEmail,
    a.contactPhone,
    a.city,
    sportsLabel(a),
    option(fieldOptions('gstStatus'), a.gstStatus),
    option(fieldOptions('commercialModel'), a.commercialModel),
    flatten(read(PRODUCTS, a.products)).join('\n'),
    flatten(read(FULFILMENT, a.fulfilment)).join('\n'),
  ]);
  return [head, ...lines].map((r) => r.map(cell).join(',')).join('\r\n');
}

const Payload = builder
  .objectRef<{ application: VendorApplication | null; userError: UserErrorShape | null }>('VendorApplicationPayload')
  .implement({
    fields: (t) => ({
      application: t.field({ type: ApplicationRef, nullable: true, resolve: (p) => p.application }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

/** Reading is for anyone in the portal; changing an application is admin's and support's. */
const workers = (ctx: Ctx) => requirePlatformStaff(ctx, ['admin', 'support']);

builder.queryFields((t) => ({
  vendorApplications: t.field({
    type: PageRef,
    description: 'portal — PL4Y Shop seller applications, newest first. At most 100 a page.',
    args: {
      filter: t.arg({ type: FilterInput }),
      limit: t.arg.int({ defaultValue: 50 }),
      offset: t.arg.int({ defaultValue: 0 }),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return vendors.list(toFilter(args.filter), { limit: args.limit ?? 50, offset: args.offset ?? 0 });
    },
  }),

  vendorApplication: t.field({
    type: ApplicationRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return vendors.byId(String(args.id));
    },
  }),

  vendorCities: t.field({
    type: ['String'],
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return vendors.cities();
    },
  }),

  vendorStatusCounts: t.field({
    type: [CountRef],
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      const counts = await vendors.counts();
      return VENDOR_STATUSES.map((status) => ({ status, count: counts[status] }));
    },
  }),

  vendorApplicationsCsv: t.field({
    type: 'String',
    description: 'portal — every application matching the filter (5,000 at most), as CSV.',
    args: { filter: t.arg({ type: FilterInput }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return toCsv(await vendors.exportRows(toFilter(args.filter)));
    },
  }),
}));

builder.mutationFields((t) => ({
  setVendorStatus: t.field({
    type: Payload,
    description: 'portal R6 — moves an application on. Kept in its history with who did it.',
    args: { id: t.arg.id({ required: true }), status: t.arg({ type: StatusEnum, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const { data, userError } = await attempt(() => vendors.setStatus(staff, String(args.id), args.status));
      return { application: data, userError };
    },
  }),

  addVendorNote: t.field({
    type: Payload,
    description: 'portal R6 — a note for the team. The seller never sees it.',
    args: { id: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const { data, userError } = await attempt(async () => {
        await vendors.addNote(staff, String(args.id), args.body);
        return vendors.byId(String(args.id));
      });
      return { application: data, userError };
    },
  }),
}));
