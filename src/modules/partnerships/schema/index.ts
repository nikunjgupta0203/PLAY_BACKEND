/**
 * partnerships — GraphQL surface (docs/modules/22-partnerships.md).
 *
 * Two public fields, for the form: sign an image upload, and submit. Nobody
 * signs in for either. Everything else is the portal's: PL4Y staff read every
 * application; admin and support work on them.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { isUserError } from '../../../platform/errors/index.js';
import { identity } from '../../identity/index.js';
import { MediaUploadPayload } from '../../venues/schema/index.js';
import {
  BASIC,
  CATEGORIES,
  CATEGORY_TITLES,
  displayName,
  flatten,
  partnerships,
  PARTNERSHIP_STATUSES,
  read,
  SECTIONS,
} from '../index.js';
import type {
  Answer,
  ApplicantType,
  Category,
  Filter,
  PartnershipApplication,
  PartnershipNote,
  PartnershipStatus,
  Receipt,
  StatusChange,
} from '../index.js';

const upper = <T extends string>(values: readonly T[]) =>
  Object.fromEntries(values.map((v) => [v.toUpperCase(), { value: v }])) as Record<string, { value: T }>;

const CategoryEnum = builder.enumType('PartnershipCategory', {
  description: 'partnerships R1 — the ways to partner with PL4Y. An application may pick several.',
  values: upper<Category>(CATEGORIES),
});

const StatusEnum = builder.enumType('PartnershipStatus', {
  description: 'partnerships R6 — where PL4Y is with an application. Submitting never makes it more than SUBMITTED.',
  values: upper<PartnershipStatus>(PARTNERSHIP_STATUSES),
});

const ApplicantTypeEnum = builder.enumType('PartnershipApplicantType', {
  values: upper<ApplicantType>(['company', 'club', 'college', 'individual', 'other']),
});

// --- the form -------------------------------------------------------------------------------

const ReceiptRef = builder.objectRef<Receipt>('PartnershipReceipt').implement({
  description: 'partnerships R3 — what the applicant is shown once their application is stored.',
  fields: (t) => ({
    reference: t.exposeString('reference'),
    organisationName: t.exposeString('organisationName'),
    categories: t.field({ type: [CategoryEnum], resolve: (r) => r.categories }),
    submittedAt: t.field({ type: 'DateTime', resolve: (r) => r.submittedAt }),
  }),
});

interface FormErrorShape extends UserErrorShape {
  field: string | null;
}

const FormErrorRef = builder.objectRef<FormErrorShape>('PartnershipFormError').implement({
  description: 'A user error that may name the question it is about.',
  fields: (t) => ({
    code: t.exposeString('code'),
    message: t.exposeString('message'),
    field: t.string({
      nullable: true,
      description: 'The question, as `step.key` or `step.key.entry.key`: `basic.email`, `venue.locations.1.city`.',
      resolve: (e) => e.field,
    }),
    retryAfterSeconds: t.int({ nullable: true, resolve: (e) => e.retryAfterSeconds ?? null }),
  }),
});

const SubmitPayload = builder
  .objectRef<{ receipt: Receipt | null; userError: FormErrorShape | null }>('SubmitPartnershipApplicationPayload')
  .implement({
    fields: (t) => ({
      receipt: t.field({ type: ReceiptRef, nullable: true, resolve: (p) => p.receipt }),
      userError: t.field({ type: FormErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const SubmitInput = builder.inputType('SubmitPartnershipApplicationInput', {
  fields: (t) => ({
    clientToken: t.id({
      required: true,
      description: 'R3 — a UUID the form makes once per attempt. Submitting it again returns the first application.',
    }),
    profile: t.field({ type: 'JSONObject', required: true, description: 'The "About you" answers, by key (R2).' }),
    categories: t.field({ type: [CategoryEnum], required: true }),
    sections: t.field({
      type: 'JSONObject',
      required: true,
      description: '`{ community: {…}, venue: {…} }` — answers by key for each category. Others are ignored.',
    }),
    consentAccurate: t.boolean({ required: true }),
    consentContact: t.boolean({ required: true }),
    consentPublish: t.boolean({ required: true, description: 'Separate permission to show their profile, logo, photos or activities.' }),
    trap: t.string({ description: 'R5 — the hidden field. Left empty by people.' }),
  }),
});

builder.mutationFields((t) => ({
  submitPartnershipApplication: t.field({
    type: SubmitPayload,
    description:
      'partnerships R1–R5 — the partnership form, sent. No sign-in. Stores one application for every ' +
      'category picked, emails the applicant a confirmation and tells the PL4Y team.',
    args: { input: t.arg({ type: SubmitInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const i = args.input;
      try {
        const receipt = await partnerships.submit(
          {
            clientToken: String(i.clientToken),
            profile: i.profile,
            categories: i.categories,
            sections: i.sections,
            consentAccurate: i.consentAccurate,
            consentContact: i.consentContact,
            consentPublish: i.consentPublish,
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

  partnershipUploadSignature: t.field({
    type: MediaUploadPayload,
    description:
      'partnerships R5 — a signature for ONE image (a logo, a venue photo, a poster), uploaded straight to ' +
      'Cloudinary. Send `folder/publicId` back in the answers. No sign-in; limited per IP.',
    args: { clientToken: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const { data, userError } = await attempt(() => partnerships.uploadSignature(String(args.clientToken), { ip: ctx.ip }));
      return { upload: data, userError };
    },
  }),
}));

// --- the portal -----------------------------------------------------------------------------

const imageUrl = (publicId: string) => cloudinary.url(publicId, TRANSFORMS.venuePhoto);

const ImageRef = builder.objectRef<string>('PartnershipImage').implement({
  fields: (t) => ({
    publicId: t.string({ resolve: (id) => id }),
    url: t.string({ nullable: true, resolve: (id) => imageUrl(id) }),
  }),
});

const AnswerRef = builder.objectRef<Answer>('PartnershipAnswer');
const EntryRef = builder.objectRef<Answer[]>('PartnershipEntry').implement({
  fields: (t) => ({ answers: t.field({ type: [AnswerRef], resolve: (e) => e }) }),
});
AnswerRef.implement({
  description: 'One question as the applicant answered it. Unanswered questions are left out.',
  fields: (t) => ({
    key: t.exposeString('key'),
    label: t.exposeString('label'),
    text: t.string({ nullable: true, description: 'The answer in words. Null for images and entries.', resolve: (a) => a.text }),
    images: t.field({ type: [ImageRef], resolve: (a) => a.images }),
    entries: t.field({ type: [EntryRef], description: 'Venue locations, activities, events.', resolve: (a) => a.entries }),
  }),
});

const SectionRef = builder.objectRef<{ category: Category; answers: Answer[] }>('PartnershipSection').implement({
  fields: (t) => ({
    category: t.field({ type: CategoryEnum, resolve: (s) => s.category }),
    title: t.string({ resolve: (s) => CATEGORY_TITLES[s.category] }),
    answers: t.field({ type: [AnswerRef], resolve: (s) => s.answers }),
  }),
});

const StaffRef = builder.objectRef<{ id: string; displayName: string }>('PartnershipStaff').implement({
  fields: (t) => ({ id: t.exposeID('id'), displayName: t.exposeString('displayName') }),
});

const person = async (id: string | null) => (id ? ((await identity.usersByIds([id]))[0] ?? null) : null);

const NoteRef = builder.objectRef<PartnershipNote>('PartnershipNote').implement({
  description: 'R6 — staff only. Never shown to the applicant.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    author: t.field({ type: StaffRef, nullable: true, resolve: (n) => person(n.authorId) }),
    createdAt: t.field({ type: 'DateTime', resolve: (n) => n.createdAt }),
  }),
});

const StatusChangeRef = builder.objectRef<StatusChange>('PartnershipStatusChange').implement({
  fields: (t) => ({
    from: t.field({ type: StatusEnum, nullable: true, resolve: (c) => c.fromStatus }),
    to: t.field({ type: StatusEnum, resolve: (c) => c.toStatus }),
    by: t.field({ type: StaffRef, nullable: true, description: 'Null for the submission itself.', resolve: (c) => person(c.byUserId) }),
    at: t.field({ type: 'DateTime', resolve: (c) => c.createdAt }),
  }),
});

const ApplicationRef = builder.objectRef<PartnershipApplication>('PartnershipApplication');
ApplicationRef.implement({
  description: 'partnerships R1 — one submission of the partnership form, with a section per category picked.',
  fields: (t) => ({
    id: t.exposeID('id'),
    reference: t.exposeString('reference'),
    applicantType: t.field({ type: ApplicantTypeEnum, resolve: (a) => a.applicantType }),
    organisationName: t.string({ nullable: true, resolve: (a) => a.organisationName }),
    displayName: t.string({ description: 'The organisation, or the person for an individual.', resolve: (a) => displayName(a) }),
    city: t.exposeString('city'),
    state: t.exposeString('state'),
    contactName: t.exposeString('contactName'),
    contactEmail: t.exposeString('contactEmail'),
    contactPhone: t.exposeString('contactPhone'),
    categories: t.field({ type: [CategoryEnum], resolve: (a) => a.categories }),
    logo: t.field({
      type: ImageRef,
      nullable: true,
      resolve: (a) => (typeof a.profile.logo === 'string' ? a.profile.logo : null),
    }),
    profile: t.field({ type: [AnswerRef], description: 'The "About you" step.', resolve: (a) => read(BASIC, a.profile) }),
    sections: t.field({
      type: [SectionRef],
      description: 'One per category picked, in the form’s order.',
      resolve: (a) => a.categories.map((category) => ({ category, answers: read(SECTIONS[category], a.sections[category] ?? {}) })),
    }),
    consentAccurate: t.exposeBoolean('consentAccurate'),
    consentContact: t.exposeBoolean('consentContact'),
    consentPublish: t.exposeBoolean('consentPublish', { description: 'May PL4Y show their profile, logo, photos or activities.' }),
    consentedAt: t.field({ type: 'DateTime', resolve: (a) => a.consentedAt }),
    status: t.field({ type: StatusEnum, resolve: (a) => a.status }),
    verified: t.boolean({ resolve: (a) => a.verifiedAt !== null }),
    verifiedAt: t.field({ type: 'DateTime', nullable: true, resolve: (a) => a.verifiedAt }),
    verifiedBy: t.field({ type: StaffRef, nullable: true, resolve: (a) => person(a.verifiedBy) }),
    assignee: t.field({ type: StaffRef, nullable: true, resolve: (a) => person(a.assignedTo) }),
    followUpOn: t.string({ nullable: true, description: 'YYYY-MM-DD.', resolve: (a) => a.followUpOn }),
    confirmationEmail: t.string({ description: 'pending, sent or failed (R4).', resolve: (a) => a.confirmationEmail }),
    linkedApplication: t.field({
      type: ApplicationRef,
      nullable: true,
      description: 'R7 — the earlier application staff linked this one to.',
      resolve: (a) => (a.linkedApplicationId ? partnerships.byId(a.linkedApplicationId) : null),
    }),
    linked: t.field({
      type: [ApplicationRef],
      description: 'R7 — every application linked to or from this one.',
      resolve: (a) => partnerships.linked(a),
    }),
    possibleDuplicates: t.field({
      type: [ApplicationRef],
      description: 'R7 — others with the same email, phone or organisation name.',
      resolve: (a) => partnerships.possibleDuplicates(a),
    }),
    notes: t.field({ type: [NoteRef], description: 'Newest first.', resolve: (a) => partnerships.notes(a.id) }),
    history: t.field({ type: [StatusChangeRef], description: 'Oldest first.', resolve: (a) => partnerships.history(a.id) }),
    createdAt: t.field({ type: 'DateTime', resolve: (a) => a.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (a) => a.updatedAt }),
  }),
});

const PageRef = builder.objectRef<{ total: number; items: PartnershipApplication[] }>('PartnershipApplicationPage').implement({
  fields: (t) => ({
    total: t.exposeInt('total'),
    items: t.field({ type: [ApplicationRef], resolve: (p) => p.items }),
  }),
});

const CountRef = builder.objectRef<{ status: PartnershipStatus; count: number }>('PartnershipStatusCount').implement({
  fields: (t) => ({
    status: t.field({ type: StatusEnum, resolve: (c) => c.status }),
    count: t.exposeInt('count'),
  }),
});

const FilterInput = builder.inputType('PartnershipFilterInput', {
  fields: (t) => ({
    search: t.string({ description: 'Organisation, contact name, email, phone or reference.' }),
    category: t.field({ type: CategoryEnum }),
    city: t.string(),
    status: t.field({ type: StatusEnum }),
  }),
});

const toFilter = (f: { search?: string | null; category?: Category | null; city?: string | null; status?: PartnershipStatus | null } | null | undefined): Filter => ({
  search: f?.search ?? null,
  category: f?.category ?? null,
  city: f?.city ?? null,
  status: f?.status ?? null,
});

/** A cell a spreadsheet will not run as a formula. */
function cell(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function toCsv(rows: PartnershipApplication[]): Promise<string> {
  const staff = new Map(
    (await identity.usersByIds(rows.flatMap((r) => [r.assignedTo, r.verifiedBy]).filter((id): id is string => id !== null))).map(
      (u) => [u.id, u.displayName],
    ),
  );
  const head = [
    'Reference', 'Submitted', 'Status', 'Organisation', 'Applicant type', 'Categories', 'Contact', 'Email', 'Phone',
    'City', 'State', 'Verified', 'Assigned to', 'Follow-up', 'Publish consent', 'Confirmation email', 'About you',
    ...CATEGORIES.map((c) => CATEGORY_TITLES[c]),
  ];
  const lines = rows.map((a) => [
    a.reference,
    a.createdAt.toISOString(),
    a.status,
    displayName(a),
    a.applicantType,
    a.categories.map((c) => CATEGORY_TITLES[c]).join('; '),
    a.contactName,
    a.contactEmail,
    a.contactPhone,
    a.city,
    a.state,
    a.verifiedAt ? 'yes' : 'no',
    a.assignedTo ? (staff.get(a.assignedTo) ?? '') : '',
    a.followUpOn ?? '',
    a.consentPublish ? 'yes' : 'no',
    a.confirmationEmail,
    flatten(read(BASIC, a.profile)).join('\n'),
    ...CATEGORIES.map((c) => (a.categories.includes(c) ? flatten(read(SECTIONS[c], a.sections[c] ?? {})).join('\n') : '')),
  ]);
  return [head, ...lines].map((r) => r.map(cell).join(',')).join('\r\n');
}

const Payload = builder
  .objectRef<{ application: PartnershipApplication | null; userError: UserErrorShape | null }>('PartnershipApplicationPayload')
  .implement({
    fields: (t) => ({
      application: t.field({ type: ApplicationRef, nullable: true, resolve: (p) => p.application }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const UpdateInput = builder.inputType('UpdatePartnershipApplicationInput', {
  description: 'R6, R7 — leave a field out to keep it; send null to clear it.',
  fields: (t) => ({
    verified: t.boolean(),
    assignedToId: t.id({ description: 'A PL4Y staff member’s user id.' }),
    followUpOn: t.string({ description: 'YYYY-MM-DD.' }),
    linkedApplicationId: t.id({ description: 'An earlier application from the same organisation.' }),
  }),
});

/** Reading is for anyone in the portal; changing an application is admin's and support's. */
const workers = (ctx: Ctx) => requirePlatformStaff(ctx, ['admin', 'support']);

builder.queryFields((t) => ({
  partnershipApplications: t.field({
    type: PageRef,
    description: 'portal — partnership applications, newest first. At most 100 a page.',
    args: {
      filter: t.arg({ type: FilterInput }),
      limit: t.arg.int({ defaultValue: 50 }),
      offset: t.arg.int({ defaultValue: 0 }),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return partnerships.list(toFilter(args.filter), { limit: args.limit ?? 50, offset: args.offset ?? 0 });
    },
  }),

  partnershipApplication: t.field({
    type: ApplicationRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return partnerships.byId(String(args.id));
    },
  }),

  partnershipCities: t.field({
    type: ['String'],
    description: 'portal — every city an application came from, for the filter.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return partnerships.cities();
    },
  }),

  partnershipStatusCounts: t.field({
    type: [CountRef],
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      const counts = await partnerships.counts();
      return PARTNERSHIP_STATUSES.map((status) => ({ status, count: counts[status] }));
    },
  }),

  partnershipApplicationsCsv: t.field({
    type: 'String',
    description: 'portal R6 — every application matching the filter (5,000 at most), as CSV.',
    args: { filter: t.arg({ type: FilterInput }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return toCsv(await partnerships.exportRows(toFilter(args.filter)));
    },
  }),
}));

builder.mutationFields((t) => ({
  setPartnershipStatus: t.field({
    type: Payload,
    description: 'portal R6 — moves an application on. Kept in its history with who did it.',
    args: { id: t.arg.id({ required: true }), status: t.arg({ type: StatusEnum, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const { data, userError } = await attempt(() => partnerships.setStatus(staff, String(args.id), args.status));
      return { application: data, userError };
    },
  }),

  addPartnershipNote: t.field({
    type: Payload,
    description: 'portal R6 — a note for the team. The applicant never sees it.',
    args: { id: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const { data, userError } = await attempt(async () => {
        await partnerships.addNote(staff, String(args.id), args.body);
        return partnerships.byId(String(args.id));
      });
      return { application: data, userError };
    },
  }),

  updatePartnershipApplication: t.field({
    type: Payload,
    args: { id: t.arg.id({ required: true }), input: t.arg({ type: UpdateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        partnerships.update(staff, String(args.id), {
          ...(i.verified !== undefined ? { verified: i.verified } : {}),
          ...(i.assignedToId !== undefined ? { assignedTo: i.assignedToId === null ? null : String(i.assignedToId) } : {}),
          ...(i.followUpOn !== undefined ? { followUpOn: i.followUpOn } : {}),
          ...(i.linkedApplicationId !== undefined
            ? { linkedApplicationId: i.linkedApplicationId === null ? null : String(i.linkedApplicationId) }
            : {}),
        }),
      );
      return { application: data, userError };
    },
  }),
}));
