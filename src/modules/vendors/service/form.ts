/**
 * vendors R2 — every question the PL4Y Shop vendor form asks, by step.
 *
 * The form app (PLAY_FRONTEND/apps/vendors, src/lib/form.ts) keeps its own
 * copy with placeholders and hints; the keys, kinds, options and required
 * flags here are the contract. Labels are what the portal, emails and CSV print.
 *
 * Deliberately absent: bank details and identity documents. Those are asked
 * only after a seller is approved.
 */
import type { Field } from '../../partnerships/index.js';

export const SELLER_TYPES = ['brand', 'retailer', 'distributor', 'individual'] as const;
export type SellerType = (typeof SELLER_TYPES)[number];

export const SELLER_TYPE_TITLES: Record<SellerType, string> = {
  brand: 'Brand / company',
  retailer: 'Retailer',
  distributor: 'Distributor',
  individual: 'Individual seller',
};

export const SPORTS = [
  ['cricket', 'Cricket'],
  ['football', 'Football'],
  ['badminton', 'Badminton'],
  ['tennis', 'Tennis'],
  ['table_tennis', 'Table tennis'],
  ['pickleball', 'Pickleball'],
  ['padel', 'Padel'],
  ['squash', 'Squash'],
  ['basketball', 'Basketball'],
  ['volleyball', 'Volleyball'],
  ['running', 'Running'],
  ['cycling', 'Cycling'],
  ['swimming', 'Swimming'],
  ['fitness', 'Fitness / training'],
  ['other', 'Other'],
] as const;
export type Sport = (typeof SPORTS)[number][0];

export const GST_STATUSES = [
  ['registered', 'Registered'],
  ['applied', 'Applied for'],
  ['not_registered', 'Not registered'],
] as const;

export const COMMERCIAL_MODELS = [
  ['commission', 'Commission per order'],
  ['vendor_plan', 'Vendor plan'],
  ['unsure', 'Help me choose'],
] as const;

export const SELLER: readonly Field[] = [
  {
    key: 'sellerType',
    label: 'Seller type',
    kind: 'choice',
    required: true,
    options: SELLER_TYPES.map((t) => [t, SELLER_TYPE_TITLES[t]] as const),
  },
  // Required for everyone but an individual: checked in service/index.ts.
  { key: 'storeName', label: 'Store / brand name', kind: 'text' },
  { key: 'contactName', label: 'Contact name', kind: 'text', required: true },
  { key: 'whatsapp', label: 'WhatsApp number', kind: 'phone', required: true },
  { key: 'email', label: 'Email', kind: 'email', required: true },
  { key: 'city', label: 'City', kind: 'text', required: true },
  { key: 'web', label: 'Website or Instagram', kind: 'text' },
];

export const PRODUCTS: readonly Field[] = [
  { key: 'sports', label: 'Sports categories', kind: 'multi', required: true, options: SPORTS },
  { key: 'sportsOther', label: 'Other sports', kind: 'text', when: { key: 'sports', includes: 'other' } },
  {
    key: 'productCount',
    label: 'Number of products',
    kind: 'choice',
    required: true,
    options: [
      ['1_20', '1–20'],
      ['21_100', '21–100'],
      ['101_500', '101–500'],
      ['500_plus', '500+'],
    ],
  },
  { key: 'priceMin', label: 'Lowest price (₹)', kind: 'number', required: true },
  { key: 'priceMax', label: 'Highest price (₹)', kind: 'number', required: true },
  {
    key: 'inventory',
    label: 'Inventory',
    kind: 'choice',
    required: true,
    options: [
      ['ready', 'Ready stock'],
      ['made_to_order', 'Made to order'],
      ['mixed', 'Mixed'],
    ],
  },
  {
    key: 'makeTime',
    label: 'Usual make time',
    kind: 'choice',
    required: true,
    when: { key: 'inventory', in: ['made_to_order', 'mixed'] },
    options: [
      ['under_3_days', 'Under 3 days'],
      ['3_7_days', '3–7 days'],
      ['1_2_weeks', '1–2 weeks'],
      ['longer', 'Longer'],
    ],
  },
  { key: 'catalogLink', label: 'Product catalogue link', kind: 'url', required: true },
];

export const FULFILMENT: readonly Field[] = [
  {
    key: 'dispatchTime',
    label: 'Dispatch time',
    kind: 'choice',
    required: true,
    options: [
      ['same_day', 'Same day'],
      ['within_48h', 'Within 48 hours'],
      ['3_5_days', '3–5 days'],
      ['5_plus_days', '5+ days'],
    ],
  },
  {
    key: 'packaging',
    label: 'Packaging ready to ship',
    kind: 'choice',
    required: true,
    options: [
      ['ready', 'Yes, ready'],
      ['partly', 'Partly'],
      ['need_help', 'Need help'],
    ],
  },
  {
    key: 'channels',
    label: 'Current sales channels',
    kind: 'multi',
    required: true,
    options: [
      ['own_website', 'Own website'],
      ['amazon', 'Amazon'],
      ['flipkart', 'Flipkart'],
      ['myntra', 'Myntra'],
      ['physical_store', 'Physical store'],
      ['social', 'Instagram / WhatsApp'],
      ['none', 'Not selling yet'],
      ['other', 'Other'],
    ],
  },
  { key: 'channelsOther', label: 'Other channels', kind: 'text', when: { key: 'channels', includes: 'other' } },
  { key: 'gstStatus', label: 'GST status', kind: 'choice', required: true, options: GST_STATUSES },
  // Format checked in service/index.ts. Optional now; nothing is verified at this stage.
  { key: 'gstin', label: 'GSTIN', kind: 'text', when: { key: 'gstStatus', equals: 'registered' } },
  { key: 'commercialModel', label: 'Preferred commercial model', kind: 'choice', required: true, options: COMMERCIAL_MODELS },
  { key: 'notes', label: 'Additional notes', kind: 'longtext' },
];

export const STEPS = { seller: SELLER, products: PRODUCTS, fulfilment: FULFILMENT } as const;
export type StepKey = keyof typeof STEPS;
export const STEP_TITLES: Record<StepKey, string> = {
  seller: 'Seller details',
  products: 'Product details',
  fulfilment: 'Fulfilment & partnership',
};
