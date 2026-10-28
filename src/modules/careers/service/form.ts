/**
 * careers R2 — every question the PL4Y careers form asks, by section.
 *
 * The form app (PLAY_FRONTEND/apps/careers, src/lib/form.ts) keeps its own
 * copy with placeholders and hints; the keys, kinds, options, `when` and
 * required flags here are the contract. Labels are what the portal, emails
 * and CSV print.
 *
 * The resume is not a question here: it is an upload, checked on its own
 * (service/index.ts).
 */
import type { Field } from '../../partnerships/index.js';

export const OPPORTUNITIES = ['campus_ambassador', 'sales_internship'] as const;
export type Opportunity = (typeof OPPORTUNITIES)[number];

export const OPPORTUNITY_TITLES: Record<Opportunity, string> = {
  campus_ambassador: 'Campus Ambassador Program',
  sales_internship: 'Sales Internship',
};

/** The reference's prefix: "CA-7K2Q9M", "SI-…". */
export const OPPORTUNITY_CODES: Record<Opportunity, string> = {
  campus_ambassador: 'CA',
  sales_internship: 'SI',
};

export const HEARD_FROM = [
  ['instagram', 'Instagram'],
  ['linkedin', 'LinkedIn'],
  ['whatsapp', 'WhatsApp'],
  ['college_friend', 'College friend'],
  ['college_group', 'College group or society'],
  ['other', 'Other'],
] as const;

/** Common to both opportunities. */
export const BASIC: readonly Field[] = [
  { key: 'fullName', label: 'Full name', kind: 'text', required: true },
  { key: 'email', label: 'Email', kind: 'email', required: true },
  { key: 'phone', label: 'Mobile number', kind: 'phone', required: true },
  { key: 'city', label: 'Current city', kind: 'text', required: true },
  { key: 'organisation', label: 'College, university or organisation', kind: 'text', required: true },
  { key: 'courseYear', label: 'Course and year', kind: 'text' },
  { key: 'linkedin', label: 'LinkedIn', kind: 'url' },
  { key: 'instagram', label: 'Instagram', kind: 'url' },
  { key: 'heardFrom', label: 'Heard about PL4Y from', kind: 'choice', required: true, options: HEARD_FROM },
  { key: 'heardFromOther', label: 'Heard from (other)', kind: 'text', when: { key: 'heardFrom', equals: 'other' } },
];

export const AMBASSADOR: readonly Field[] = [
  { key: 'college', label: 'College or university represented', kind: 'text', required: true },
  { key: 'collegeCity', label: 'College city', kind: 'text', required: true },
  {
    key: 'studyYear',
    label: 'Year of study',
    kind: 'choice',
    required: true,
    options: [
      ['year_1', '1st year'],
      ['year_2', '2nd year'],
      ['year_3', '3rd year'],
      ['year_4', '4th year'],
      ['year_5', '5th year'],
      ['postgraduate', 'Postgraduate'],
    ],
  },
  { key: 'communities', label: 'Societies, clubs or student communities', kind: 'longtext', required: true },
  { key: 'leadership', label: 'Leadership or organising experience', kind: 'longtext', required: true },
  {
    key: 'reach',
    label: 'Students they can reach directly',
    kind: 'choice',
    required: true,
    options: [
      ['under_50', 'Under 50'],
      ['50_100', '50–100'],
      ['100_300', '100–300'],
      ['300_plus', '300+'],
    ],
  },
  {
    key: 'platforms',
    label: 'Most active on',
    kind: 'multi',
    required: true,
    options: [
      ['instagram', 'Instagram'],
      ['whatsapp', 'WhatsApp'],
      ['linkedin', 'LinkedIn'],
      ['other', 'Other'],
    ],
  },
  { key: 'platformsOther', label: 'Other platforms', kind: 'text', when: { key: 'platforms', includes: 'other' } },
  {
    key: 'weeklyHours',
    label: 'Time each week',
    kind: 'choice',
    required: true,
    options: [
      ['2_3', '2–3 hours'],
      ['4_5', '4–5 hours'],
      ['6_8', '6–8 hours'],
      ['8_plus', '8+ hours'],
    ],
  },
  { key: 'promotion', label: 'How they would promote PL4Y', kind: 'longtext', required: true },
  { key: 'motivation', label: 'Why they want to be an ambassador', kind: 'longtext', required: true },
  { key: 'additional', label: 'Anything else', kind: 'longtext' },
];

export const SALES: readonly Field[] = [
  { key: 'interest', label: 'What interests them about sales and business development', kind: 'longtext', required: true },
  { key: 'hasExperience', label: 'Previous sales or customer-facing experience', kind: 'yesno', required: true },
  { key: 'experience', label: 'Their experience', kind: 'longtext', required: true, when: { key: 'hasExperience', equals: true } },
  { key: 'outreachOk', label: 'Comfortable reaching out by call, WhatsApp, email and LinkedIn', kind: 'yesno', required: true },
  { key: 'pitchingOk', label: 'Comfortable pitching to business owners', kind: 'yesno', required: true },
  { key: 'partnerPitch', label: 'How they would convince a venue or academy', kind: 'longtext', required: true },
  {
    key: 'dailyHours',
    label: 'Hours a day',
    kind: 'choice',
    required: true,
    options: [
      ['1_2', '1–2 hours'],
      ['2_3', '2–3 hours'],
      ['3_4', '3–4 hours'],
      ['4_plus', '4+ hours'],
    ],
  },
  {
    key: 'availability',
    label: 'Can start',
    kind: 'choice',
    required: true,
    options: [
      ['immediate', 'Immediately'],
      ['one_week', 'Within one week'],
      ['two_weeks', 'Within two weeks'],
      ['other', 'Other'],
    ],
  },
  { key: 'availabilityOther', label: 'Start date (other)', kind: 'text', when: { key: 'availability', equals: 'other' } },
  {
    key: 'workMode',
    label: 'Remote, hybrid or on-site',
    kind: 'choice',
    required: true,
    options: [
      ['remote', 'Remote'],
      ['hybrid', 'Hybrid'],
      ['onsite', 'On-site'],
      ['any', 'Open to any'],
    ],
  },
  { key: 'whyYou', label: 'Why we should consider them', kind: 'longtext', required: true },
  { key: 'additional', label: 'Anything else', kind: 'longtext' },
];

export const QUESTIONS: Record<Opportunity, readonly Field[]> = {
  campus_ambassador: AMBASSADOR,
  sales_internship: SALES,
};

export const SECTION_TITLES: Record<Opportunity, string> = {
  campus_ambassador: 'Campus Ambassador answers',
  sales_internship: 'Sales Internship answers',
};
