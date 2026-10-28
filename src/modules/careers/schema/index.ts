/**
 * careers — GraphQL surface (docs/modules/24-careers.md).
 *
 * Two public fields, for the form: sign a resume upload, and submit. Nobody
 * signs in for either. Everything else is the portal's: PL4Y staff read every
 * application and open resumes; admin and support work on them.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { isUserError } from '../../../platform/errors/index.js';
import { identity } from '../../identity/index.js';
import { flatten, read, type Answer } from '../../partnerships/index.js';
import { BASIC, CAREER_STATUSES, careers, OPPORTUNITIES, OPPORTUNITY_TITLES, QUESTIONS, SECTION_TITLES } from '../index.js';
import type { CareerApplication, CareerNote, CareerStatus, Filter, Opportunity, Receipt, ResumeUpload, StatusChange } from '../index.js';

const upper = <T extends string>(values: readonly T[]) =>
  Object.fromEntries(values.map((v) => [v.toUpperCase(), { value: v }])) as Record<string, { value: T }>;

const StatusEnum = builder.enumType('CareerStatus', {
  description: 'careers R7 — where PL4Y is with an application. Submitting makes it NEW.',
  values: upper<CareerStatus>(CAREER_STATUSES),
});

const OpportunityEnum = builder.enumType('CareerOpportunity', { values: upper<Opportunity>(OPPORTUNITIES) });

// --- the form -------------------------------------------------------------------------------

const UploadRef = builder.objectRef<ResumeUpload>('CareerResumeUpload').implement({
  description:
    'careers R5 — POST the PDF to `uploadUrl` as multipart form data with `file` and every field here ' +
    '(api_key, timestamp, signature, public_id, folder, upload_preset, type). Send the returned public_id back on submit.',
  fields: (t) => ({
    cloudName: t.exposeString('cloudName'),
    apiKey: t.exposeString('apiKey'),
    timestamp: t.exposeInt('timestamp'),
    publicId: t.exposeString('publicId'),
    folder: t.exposeString('folder'),
    uploadPreset: t.exposeString('uploadPreset'),
    type: t.exposeString('type'),
    signature: t.exposeString('signature'),
    uploadUrl: t.exposeString('uploadUrl'),
    expiresAt: t.field({ type: 'DateTime', resolve: (u) => u.expiresAt }),
  }),
});

const UploadPayload = builder
  .objectRef<{ upload: ResumeUpload | null; userError: UserErrorShape | null }>('CareerResumeUploadPayload')
  .implement({
    fields: (t) => ({
      upload: t.field({ type: UploadRef, nullable: true, resolve: (p) => p.upload }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ReceiptRef = builder.objectRef<Receipt>('CareerReceipt').implement({
  description: 'careers R3 — what the applicant is shown once their application is stored.',
  fields: (t) => ({
    reference: t.exposeString('reference'),
    opportunity: t.field({ type: OpportunityEnum, resolve: (r) => r.opportunity }),
    opportunityTitle: t.string({ resolve: (r) => OPPORTUNITY_TITLES[r.opportunity] }),
    fullName: t.exposeString('fullName'),
    submittedAt: t.field({ type: 'DateTime', resolve: (r) => r.submittedAt }),
  }),
});

interface FormErrorShape extends UserErrorShape {
  field: string | null;
}

const FormErrorRef = builder.objectRef<FormErrorShape>('CareerFormError').implement({
  description: 'A user error that may name the question it is about.',
  fields: (t) => ({
    code: t.exposeString('code'),
    message: t.exposeString('message'),
    field: t.string({ nullable: true, description: 'The question, as `section.key`: `basic.email`, `answers.reach`.', resolve: (e) => e.field }),
    retryAfterSeconds: t.int({ nullable: true, resolve: (e) => e.retryAfterSeconds ?? null }),
  }),
});

const SubmitPayload = builder
  .objectRef<{ receipt: Receipt | null; userError: FormErrorShape | null }>('SubmitCareerApplicationPayload')
  .implement({
    fields: (t) => ({
      receipt: t.field({ type: ReceiptRef, nullable: true, resolve: (p) => p.receipt }),
      userError: t.field({ type: FormErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ResumeInput = builder.inputType('CareerResumeInput', {
  fields: (t) => ({
    publicId: t.string({ required: true, description: 'The public_id Cloudinary returned for the upload.' }),
    name: t.string({ required: true, description: 'The file name, as the applicant had it.' }),
  }),
});

const SubmitInput = builder.inputType('SubmitCareerApplicationInput', {
  fields: (t) => ({
    clientToken: t.id({ required: true, description: 'R3 — a UUID the form makes once per attempt.' }),
    opportunity: t.field({ type: OpportunityEnum, required: true }),
    basic: t.field({ type: 'JSONObject', required: true, description: 'Basic details, by key (R2).' }),
    answers: t.field({ type: 'JSONObject', required: true, description: 'The opportunity’s own answers, by key.' }),
    resume: t.field({ type: ResumeInput, description: 'R5 — optional.' }),
    consent: t.boolean({ required: true }),
    trap: t.string({ description: 'R6 — the hidden field. Left empty by people.' }),
  }),
});

const formError = (e: unknown): FormErrorShape => {
  if (!isUserError(e)) throw e;
  const field = typeof e.details?.field === 'string' ? e.details.field : null;
  return { code: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds ?? null, field };
};

builder.mutationFields((t) => ({
  careerResumeUpload: t.field({
    type: UploadPayload,
    description: 'careers R5 — a signature for ONE private PDF upload, straight to Cloudinary. No sign-in; limited per IP.',
    args: { clientToken: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const { data, userError } = await attempt(() => careers.resumeUpload(String(args.clientToken), { ip: ctx.ip }));
      return { upload: data, userError };
    },
  }),

  submitCareerApplication: t.field({
    type: SubmitPayload,
    description: 'careers R1–R6 — the careers form, sent. No sign-in. Emails the applicant and tells the team.',
    args: { input: t.arg({ type: SubmitInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const i = args.input;
      try {
        const receipt = await careers.submit(
          {
            clientToken: String(i.clientToken),
            opportunity: i.opportunity,
            basic: i.basic,
            answers: i.answers,
            resume: i.resume ?? null,
            consent: i.consent,
            trap: i.trap ?? null,
          },
          { ip: ctx.ip },
        );
        return { receipt, userError: null };
      } catch (e) {
        return { receipt: null, userError: formError(e) };
      }
    },
  }),
}));

// --- the portal -----------------------------------------------------------------------------

const AnswerRef = builder.objectRef<Answer>('CareerAnswer').implement({
  description: 'One question as the applicant answered it. Unanswered questions are left out.',
  fields: (t) => ({
    key: t.exposeString('key'),
    label: t.exposeString('label'),
    text: t.string({ nullable: true, resolve: (a) => a.text }),
  }),
});

const SectionRef = builder.objectRef<{ title: string; answers: Answer[] }>('CareerSection').implement({
  fields: (t) => ({
    title: t.exposeString('title'),
    answers: t.field({ type: [AnswerRef], resolve: (s) => s.answers }),
  }),
});

const sections = (a: CareerApplication) => [
  { title: 'Basic information', answers: read(BASIC, a.basic) },
  { title: SECTION_TITLES[a.opportunity], answers: read(QUESTIONS[a.opportunity], a.answers) },
];

const StaffRef = builder.objectRef<{ id: string; displayName: string }>('CareerStaff').implement({
  fields: (t) => ({ id: t.exposeID('id'), displayName: t.exposeString('displayName') }),
});

const person = async (id: string | null) => (id ? ((await identity.usersByIds([id]))[0] ?? null) : null);

const NoteRef = builder.objectRef<CareerNote>('CareerNote').implement({
  description: 'R7 — staff only. Never shown to the applicant.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    author: t.field({ type: StaffRef, nullable: true, resolve: (n) => person(n.authorId) }),
    createdAt: t.field({ type: 'DateTime', resolve: (n) => n.createdAt }),
  }),
});

const StatusChangeRef = builder.objectRef<StatusChange>('CareerStatusChange').implement({
  fields: (t) => ({
    from: t.field({ type: StatusEnum, nullable: true, resolve: (c) => c.fromStatus }),
    to: t.field({ type: StatusEnum, resolve: (c) => c.toStatus }),
    by: t.field({ type: StaffRef, nullable: true, description: 'Null for the submission itself.', resolve: (c) => person(c.byUserId) }),
    at: t.field({ type: 'DateTime', resolve: (c) => c.createdAt }),
  }),
});

/** The college an ambassador represents, else where they study or work. */
const college = (a: CareerApplication) => (typeof a.answers.college === 'string' ? a.answers.college : a.organisation);

const ApplicationRef = builder.objectRef<CareerApplication>('CareerApplication');
ApplicationRef.implement({
  description: 'careers R1 — one submission of the careers form.',
  fields: (t) => ({
    id: t.exposeID('id'),
    reference: t.exposeString('reference'),
    opportunity: t.field({ type: OpportunityEnum, resolve: (a) => a.opportunity }),
    opportunityTitle: t.string({ resolve: (a) => OPPORTUNITY_TITLES[a.opportunity] }),
    fullName: t.exposeString('fullName'),
    email: t.exposeString('email'),
    phone: t.exposeString('phone'),
    city: t.exposeString('city'),
    organisation: t.exposeString('organisation'),
    college: t.string({ description: 'The college an ambassador represents, else the organisation.', resolve: college }),
    linkedin: t.string({ nullable: true, resolve: (a) => (typeof a.basic.linkedin === 'string' ? a.basic.linkedin : null) }),
    instagram: t.string({ nullable: true, resolve: (a) => (typeof a.basic.instagram === 'string' ? a.basic.instagram : null) }),
    hasResume: t.boolean({ resolve: (a) => a.resume !== null }),
    resumeName: t.string({ nullable: true, resolve: (a) => a.resume?.name ?? null }),
    sections: t.field({ type: [SectionRef], description: 'Basic information, then the opportunity’s answers.', resolve: sections }),
    consentedAt: t.field({ type: 'DateTime', resolve: (a) => a.consentedAt }),
    status: t.field({ type: StatusEnum, resolve: (a) => a.status }),
    statusChangedAt: t.field({ type: 'DateTime', resolve: (a) => a.statusChangedAt }),
    confirmationEmail: t.string({ description: 'pending, sent or failed (R4).', resolve: (a) => a.confirmationEmail }),
    notes: t.field({ type: [NoteRef], description: 'Newest first.', resolve: (a) => careers.notes(a.id) }),
    history: t.field({ type: [StatusChangeRef], description: 'Oldest first.', resolve: (a) => careers.history(a.id) }),
    others: t.field({ type: [ApplicationRef], description: 'Other applications from the same email.', resolve: (a) => careers.others(a) }),
    createdAt: t.field({ type: 'DateTime', resolve: (a) => a.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (a) => a.updatedAt }),
  }),
});

const PageRef = builder.objectRef<{ total: number; items: CareerApplication[] }>('CareerApplicationPage').implement({
  fields: (t) => ({
    total: t.exposeInt('total'),
    items: t.field({ type: [ApplicationRef], resolve: (p) => p.items }),
  }),
});

const CountRef = builder.objectRef<{ opportunity: Opportunity; status: CareerStatus; count: number }>('CareerCount').implement({
  fields: (t) => ({
    opportunity: t.field({ type: OpportunityEnum, resolve: (c) => c.opportunity }),
    status: t.field({ type: StatusEnum, resolve: (c) => c.status }),
    count: t.exposeInt('count'),
  }),
});

const FilterInput = builder.inputType('CareerFilterInput', {
  fields: (t) => ({
    search: t.string({ description: 'Name, email, phone, city, college / organisation or reference.' }),
    opportunity: t.field({ type: OpportunityEnum }),
    status: t.field({ type: StatusEnum }),
  }),
});

const toFilter = (f: { search?: string | null; opportunity?: Opportunity | null; status?: CareerStatus | null } | null | undefined): Filter => ({
  search: f?.search ?? null,
  opportunity: f?.opportunity ?? null,
  status: f?.status ?? null,
});

/** A cell a spreadsheet will not run as a formula. */
function cell(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_WORDS: Record<CareerStatus, string> = {
  new: 'New',
  under_review: 'Under review',
  shortlisted: 'Shortlisted',
  interview: 'Interview',
  selected: 'Selected',
  rejected: 'Rejected',
};

function toCsv(rows: CareerApplication[]): string {
  const head = [
    'Reference', 'Submitted', 'Opportunity', 'Status', 'Status changed', 'Name', 'Email', 'Mobile', 'City',
    'College / organisation', 'Course and year', 'LinkedIn', 'Instagram', 'Heard from', 'Resume', 'Answers',
  ];
  const lines = rows.map((a) => {
    const basic = new Map(read(BASIC, a.basic).map((x) => [x.key, x.text ?? '']));
    return [
      a.reference,
      a.createdAt.toISOString(),
      OPPORTUNITY_TITLES[a.opportunity],
      STATUS_WORDS[a.status],
      a.statusChangedAt.toISOString(),
      a.fullName,
      a.email,
      a.phone,
      a.city,
      college(a),
      basic.get('courseYear') ?? '',
      basic.get('linkedin') ?? '',
      basic.get('instagram') ?? '',
      [basic.get('heardFrom'), basic.get('heardFromOther')].filter(Boolean).join(': '),
      a.resume ? 'Yes' : 'No',
      flatten(read(QUESTIONS[a.opportunity], a.answers)).join('\n'),
    ];
  });
  return [head, ...lines].map((r) => r.map(cell).join(',')).join('\r\n');
}

const Payload = builder
  .objectRef<{ application: CareerApplication | null; userError: UserErrorShape | null }>('CareerApplicationPayload')
  .implement({
    fields: (t) => ({
      application: t.field({ type: ApplicationRef, nullable: true, resolve: (p) => p.application }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const LinkPayload = builder.objectRef<{ url: string | null; userError: UserErrorShape | null }>('CareerResumeLinkPayload').implement({
  fields: (t) => ({
    url: t.string({ nullable: true, description: 'Works for five minutes.', resolve: (p) => p.url }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});

/** Reading is for anyone in the portal; changing an application is admin's and support's. */
const workers = (ctx: Ctx) => requirePlatformStaff(ctx, ['admin', 'support']);

builder.queryFields((t) => ({
  careerApplications: t.field({
    type: PageRef,
    description: 'portal — careers applications, newest first. At most 100 a page.',
    args: {
      filter: t.arg({ type: FilterInput }),
      limit: t.arg.int({ defaultValue: 50 }),
      offset: t.arg.int({ defaultValue: 0 }),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return careers.list(toFilter(args.filter), { limit: args.limit ?? 50, offset: args.offset ?? 0 });
    },
  }),

  careerApplication: t.field({
    type: ApplicationRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return careers.byId(String(args.id));
    },
  }),

  careerCounts: t.field({
    type: [CountRef],
    description: 'Every opportunity × status, zeros included.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return careers.counts();
    },
  }),

  careerApplicationsCsv: t.field({
    type: 'String',
    description: 'portal — every application matching the filter (5,000 at most), as CSV.',
    args: { filter: t.arg({ type: FilterInput }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return toCsv(await careers.exportRows(toFilter(args.filter)));
    },
  }),
}));

builder.mutationFields((t) => ({
  openCareerResume: t.field({
    type: LinkPayload,
    description: 'portal R5 — a download link for the applicant’s resume that expires in five minutes.',
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const { data, userError } = await attempt(() => careers.resumeLink(String(args.id)));
      return { url: data, userError };
    },
  }),

  setCareerStatus: t.field({
    type: Payload,
    description: 'portal R7 — moves an application on. Kept in its history with who did it and when.',
    args: { id: t.arg.id({ required: true }), status: t.arg({ type: StatusEnum, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const { data, userError } = await attempt(() => careers.setStatus(staff, String(args.id), args.status));
      return { application: data, userError };
    },
  }),

  addCareerNote: t.field({
    type: Payload,
    description: 'portal R7 — a note for the team. The applicant never sees it.',
    args: { id: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await workers(ctx);
      const { data, userError } = await attempt(async () => {
        await careers.addNote(staff, String(args.id), args.body);
        return careers.byId(String(args.id));
      });
      return { application: data, userError };
    },
  }),
}));
