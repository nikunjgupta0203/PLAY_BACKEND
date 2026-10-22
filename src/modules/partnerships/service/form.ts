/**
 * partnerships R2 — every question the partnership form asks, by step.
 *
 * The form app (PLAY_FRONTEND/apps/partners, src/lib/form.ts) keeps its own
 * copy with placeholders and hints; the keys, kinds, options and required
 * flags here are the contract, and the server holds to them whatever a client
 * sends. The labels are what the portal, the emails and the CSV print.
 */

export const CATEGORIES = ['community', 'college', 'venue', 'events', 'ambassador', 'brand', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_TITLES: Record<Category, string> = {
  community: 'Sports Club / Community',
  college: 'College / University',
  venue: 'Sports Venue / Facility',
  events: 'Tournament / Event Organiser',
  ambassador: 'Campus Ambassador',
  brand: 'Brand / Commercial Partner',
  other: 'Other Partnership',
};

export const APPLICANT_TYPES = ['company', 'club', 'college', 'individual', 'other'] as const;
export type ApplicantType = (typeof APPLICANT_TYPES)[number];

export type Kind =
  | 'text'
  | 'longtext'
  | 'email'
  | 'phone'
  | 'url'
  | 'number'
  | 'date'
  | 'datetime'
  | 'choice'
  | 'multi'
  | 'yesno'
  /** One uploaded image: a Cloudinary public_id under the attempt's folder. */
  | 'image'
  /** Up to MAX_IMAGES of them. */
  | 'images'
  /** A list of entries, each answering `fields`. */
  | 'repeat';

export interface Field {
  key: string;
  label: string;
  kind: Kind;
  required?: boolean;
  /** For choice and multi: [value, label]. */
  options?: readonly (readonly [string, string])[];
  /** Asked only when another answer in the same step (or entry) matches. */
  when?: { key: string; equals?: string | boolean; includes?: string };
  /** For repeat. */
  fields?: readonly Field[];
  /** For repeat: at least this many entries (when the field is asked). */
  min?: number;
}

/** The sports offered wherever a step asks which ones. "other" is followed by a text answer. */
const SPORTS = [
  ['running', 'Running'],
  ['badminton', 'Badminton'],
  ['pickleball', 'Pickleball'],
  ['football', 'Football'],
  ['cricket', 'Cricket'],
  ['tennis', 'Tennis'],
  ['table_tennis', 'Table tennis'],
  ['basketball', 'Basketball'],
  ['volleyball', 'Volleyball'],
  ['padel', 'Padel'],
  ['squash', 'Squash'],
  ['cycling', 'Cycling'],
  ['swimming', 'Swimming'],
  ['fitness', 'Fitness / training'],
  ['other', 'Other'],
] as const;

const YES_MAYBE_NO = [
  ['yes', 'Yes'],
  ['maybe', 'Maybe'],
  ['no', 'No'],
] as const;

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
  'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal', 'Outside India',
] as const;

const sports = (key = 'sports', required = false): Field[] => [
  { key, label: 'Sports', kind: 'multi', options: SPORTS, required },
  { key: `${key}Other`, label: 'Other sports', kind: 'text', when: { key, includes: 'other' } },
];

const interests = (options: readonly (readonly [string, string])[]): Field[] => [
  { key: 'interests', label: 'Partnership interests', kind: 'multi', options: [...options, ['other', 'Other']], required: true },
  { key: 'interestsOther', label: 'Other interest', kind: 'text', when: { key: 'interests', includes: 'other' } },
];

export const BASIC: readonly Field[] = [
  {
    key: 'applicantType',
    label: 'Applicant type',
    kind: 'choice',
    required: true,
    options: [
      ['company', 'Registered company / business'],
      ['club', 'Sports club / community'],
      ['college', 'College / university'],
      ['individual', 'Individual'],
      ['other', 'Other organisation'],
    ],
  },
  // Required for everyone but an individual: checked in service/index.ts.
  { key: 'organisationName', label: 'Organisation / company / club name', kind: 'text' },
  { key: 'description', label: 'Short description', kind: 'longtext', required: true },
  { key: 'website', label: 'Website', kind: 'url' },
  { key: 'instagram', label: 'Instagram', kind: 'text' },
  { key: 'linkedin', label: 'LinkedIn', kind: 'text' },
  { key: 'city', label: 'City', kind: 'text', required: true },
  { key: 'state', label: 'State', kind: 'choice', required: true, options: INDIAN_STATES.map((s) => [s, s] as const) },
  { key: 'operatingAreas', label: 'Operating areas', kind: 'text' },
  { key: 'logo', label: 'Logo', kind: 'image' },
  { key: 'contactName', label: 'Contact name', kind: 'text', required: true },
  { key: 'contactRole', label: 'Designation / role', kind: 'text' },
  { key: 'email', label: 'Email', kind: 'email', required: true },
  { key: 'phone', label: 'Phone', kind: 'phone', required: true },
  {
    key: 'preferredContact',
    label: 'Preferred contact method',
    kind: 'choice',
    required: true,
    options: [
      ['whatsapp', 'WhatsApp'],
      ['phone', 'Phone call'],
      ['email', 'Email'],
    ],
  },
  {
    key: 'size',
    label: 'Organisation size',
    kind: 'choice',
    options: [
      ['1-10', '1–10 people'],
      ['11-50', '11–50 people'],
      ['51-200', '51–200 people'],
      ['201-1000', '201–1,000 people'],
      ['1000+', 'More than 1,000'],
    ],
  },
  {
    key: 'heardFrom',
    label: 'Heard about PL4Y from',
    kind: 'choice',
    options: [
      ['team', 'The PL4Y team reached out'],
      ['instagram', 'Instagram'],
      ['linkedin', 'LinkedIn'],
      ['whatsapp', 'WhatsApp'],
      ['friend', 'A friend or colleague'],
      ['event', 'At an event'],
      ['search', 'Search'],
      ['other', 'Other'],
    ],
  },
  { key: 'anythingElse', label: 'Anything else', kind: 'longtext' },
];

const COMMUNITY: readonly Field[] = [
  { key: 'communityName', label: 'Community / club name', kind: 'text' },
  ...sports('sports', true),
  { key: 'communityDescription', label: 'About the community', kind: 'longtext' },
  { key: 'totalMembers', label: 'Total membership', kind: 'number' },
  { key: 'activeMembers', label: 'Active members', kind: 'number' },
  { key: 'typicalAttendance', label: 'Typical attendance per activity', kind: 'number' },
  {
    key: 'frequency',
    label: 'How often activities run',
    kind: 'choice',
    options: [
      ['daily', 'Daily'],
      ['several_weekly', 'Several times a week'],
      ['weekly', 'Weekly'],
      ['fortnightly', 'Every two weeks'],
      ['monthly', 'Monthly'],
      ['occasionally', 'Occasionally'],
    ],
  },
  { key: 'locations', label: 'Usual activity locations', kind: 'longtext' },
  { key: 'links', label: 'Social media / community links', kind: 'longtext' },
  {
    key: 'pricing',
    label: 'Activities are',
    kind: 'choice',
    options: [
      ['free', 'Free'],
      ['paid', 'Paid'],
      ['both', 'Both'],
    ],
  },
  { key: 'membershipFees', label: 'Charges membership fees', kind: 'yesno' },
  { key: 'discovery', label: 'How new members find and join', kind: 'longtext' },
  { key: 'wantsCommunity', label: 'Interested in a PL4Y community', kind: 'choice', options: YES_MAYBE_NO },
  {
    key: 'communityType',
    label: 'Preferred community type',
    kind: 'choice',
    options: [
      ['free_public', 'Free and public'],
      ['free_private', 'Free and private'],
      ['paid', 'Paid membership'],
      ['undecided', 'Not decided yet'],
    ],
  },
  { key: 'hasUpcoming', label: 'Has upcoming activities', kind: 'yesno', required: true },
  {
    key: 'activities',
    label: 'Upcoming activities',
    kind: 'repeat',
    min: 1,
    when: { key: 'hasUpcoming', equals: true },
    fields: [
      { key: 'name', label: 'Activity name', kind: 'text', required: true },
      { key: 'sport', label: 'Sport', kind: 'text' },
      { key: 'startsAt', label: 'Date and time', kind: 'datetime' },
      { key: 'location', label: 'Location / meeting point', kind: 'text' },
      { key: 'capacity', label: 'Expected capacity', kind: 'number' },
      { key: 'fee', label: 'Participation fee', kind: 'text' },
      { key: 'registrationLink', label: 'Registration link', kind: 'url' },
    ],
  },
  ...interests([
    ['discovery', 'Get discovered by more players'],
    ['publish', 'Publish activities on PL4Y'],
    ['grow', 'Grow community membership'],
    ['community', 'Create a PL4Y community'],
    ['events', 'Organise sports events'],
  ]),
  { key: 'willPublish', label: 'Would publish activities after launch', kind: 'choice', options: YES_MAYBE_NO },
];

const COLLEGE: readonly Field[] = [
  { key: 'institutionName', label: 'College / university name', kind: 'text', required: true },
  {
    key: 'institutionType',
    label: 'Institution type',
    kind: 'choice',
    options: [
      ['university', 'University'],
      ['engineering', 'Engineering college'],
      ['arts_science', 'Arts and science college'],
      ['management', 'Management school'],
      ['medical', 'Medical college'],
      ['school', 'School'],
      ['other', 'Other'],
    ],
  },
  { key: 'campusLocation', label: 'Campus location', kind: 'text' },
  { key: 'links', label: 'Website and social links', kind: 'longtext' },
  { key: 'studentPopulation', label: 'Student population', kind: 'number' },
  ...sports(),
  { key: 'societiesCount', label: 'Sports societies / clubs', kind: 'number' },
  { key: 'societyNames', label: 'Names of the societies', kind: 'longtext' },
  { key: 'sportsParticipants', label: 'Students playing sport', kind: 'number' },
  { key: 'competitions', label: 'Existing competitions or leagues', kind: 'longtext' },
  { key: 'coordinatorName', label: 'Sports coordinator', kind: 'text' },
  { key: 'coordinatorRole', label: 'Coordinator’s role', kind: 'text' },
  ...interests([
    ['introduce', 'Introduce PL4Y to students'],
    ['societies', 'Onboard college sports societies'],
    ['publish', 'Publish college sports activities'],
    ['intercollege', 'Organise inter-college competitions'],
    ['communities', 'Build student sports communities'],
    ['ambassadors', 'Recruit campus ambassadors'],
  ]),
  { key: 'reach', label: 'Students the college could reach', kind: 'number' },
  { key: 'launchInterest', label: 'Interested in PL4Y’s launch', kind: 'choice', options: YES_MAYBE_NO },
  { key: 'firstActivity', label: 'Possible first activity or campaign', kind: 'longtext' },
  {
    key: 'timeframe',
    label: 'Preferred timeframe',
    kind: 'choice',
    options: [
      ['now', 'This month'],
      ['1-3m', 'In 1–3 months'],
      ['3-6m', 'In 3–6 months'],
      ['later', 'Later / not sure'],
    ],
  },
];

const VENUE_FACILITIES = [
  ['parking', 'Parking'],
  ['changing', 'Changing rooms'],
  ['washrooms', 'Washrooms'],
  ['water', 'Drinking water'],
  ['floodlights', 'Floodlights'],
  ['seating', 'Seating'],
  ['cafe', 'Café / snacks'],
  ['rental', 'Equipment rental'],
  ['first_aid', 'First aid'],
  ['wifi', 'Wi-Fi'],
] as const;

const VENUE: readonly Field[] = [
  { key: 'businessName', label: 'Venue / business name', kind: 'text', required: true },
  { key: 'parentCompany', label: 'Parent company', kind: 'text' },
  { key: 'locationCount', label: 'Number of locations', kind: 'number' },
  { key: 'website', label: 'Website', kind: 'url' },
  { key: 'bookingPlatform', label: 'Existing booking platform', kind: 'text' },
  { key: 'links', label: 'Social media links', kind: 'longtext' },
  {
    key: 'locations',
    label: 'Venue locations',
    kind: 'repeat',
    required: true,
    min: 1,
    fields: [
      { key: 'name', label: 'Venue name', kind: 'text', required: true },
      { key: 'address', label: 'Address', kind: 'longtext', required: true },
      { key: 'mapsUrl', label: 'Google Maps link', kind: 'url' },
      { key: 'city', label: 'City', kind: 'text', required: true },
      { key: 'locality', label: 'Locality', kind: 'text' },
      ...sports(),
      { key: 'facilities', label: 'Facilities', kind: 'multi', options: VENUE_FACILITIES },
      {
        key: 'setting',
        label: 'Indoor / outdoor',
        kind: 'choice',
        options: [
          ['indoor', 'Indoor'],
          ['outdoor', 'Outdoor'],
          ['both', 'Both'],
        ],
      },
      { key: 'hours', label: 'Operating hours', kind: 'text' },
      { key: 'courts', label: 'Courts / grounds', kind: 'number' },
      { key: 'pricing', label: 'Hourly price or range', kind: 'text' },
      { key: 'contact', label: 'Venue contact', kind: 'text' },
      { key: 'bookingLink', label: 'Booking link', kind: 'url' },
      { key: 'photos', label: 'Photos', kind: 'images' },
    ],
  },
  { key: 'bookingManagement', label: 'How bookings are managed today', kind: 'longtext' },
  { key: 'bookingPlatforms', label: 'Booking platforms used', kind: 'text' },
  { key: 'directBookings', label: 'Takes direct bookings', kind: 'yesno' },
  {
    key: 'offerings',
    label: 'Also offers',
    kind: 'multi',
    options: [
      ['coaching', 'Coaching'],
      ['memberships', 'Memberships'],
      ['leagues', 'Leagues'],
      ['events', 'Events'],
    ],
  },
  ...interests([
    ['listing', 'Venue listing on PL4Y'],
    ['referrals', 'Booking referrals'],
    ['integration', 'Booking integration'],
    ['events', 'Venue-led sports events'],
    ['offers', 'Promotional offers'],
    ['multi_location', 'Multi-location partnership'],
  ]),
  { key: 'commissionOpen', label: 'Open to a referral or commission arrangement', kind: 'choice', options: YES_MAYBE_NO },
];

const EVENTS: readonly Field[] = [
  { key: 'organiserName', label: 'Organiser / company name', kind: 'text', required: true },
  ...sports('sports', true),
  {
    key: 'formats',
    label: 'Event formats',
    kind: 'multi',
    options: [
      ['knockout', 'Knockout'],
      ['league', 'League'],
      ['round_robin', 'Round robin'],
      ['groups_knockout', 'Groups + knockout'],
      ['race', 'Run / race'],
      ['social', 'Social / open play'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'eventsCount',
    label: 'Events organised so far',
    kind: 'choice',
    options: [
      ['0', 'None yet'],
      ['1-5', '1–5'],
      ['6-20', '6–20'],
      ['21-50', '21–50'],
      ['50+', 'More than 50'],
    ],
  },
  { key: 'typicalParticipants', label: 'Typical participants per event', kind: 'number' },
  { key: 'coverage', label: 'Geographic coverage', kind: 'text' },
  { key: 'links', label: 'Website and social links', kind: 'longtext' },
  { key: 'registrationPlatforms', label: 'Registration platforms used', kind: 'text' },
  { key: 'hasUpcoming', label: 'Has upcoming events', kind: 'yesno', required: true },
  {
    key: 'events',
    label: 'Upcoming events',
    kind: 'repeat',
    min: 1,
    when: { key: 'hasUpcoming', equals: true },
    fields: [
      { key: 'name', label: 'Event name', kind: 'text', required: true },
      { key: 'sport', label: 'Sport', kind: 'text' },
      { key: 'format', label: 'Format', kind: 'text' },
      { key: 'dates', label: 'Date(s)', kind: 'text' },
      { key: 'venue', label: 'Venue and location', kind: 'text' },
      { key: 'registrationOpens', label: 'Registration opens', kind: 'date' },
      { key: 'registrationCloses', label: 'Registration deadline', kind: 'date' },
      { key: 'capacity', label: 'Participant capacity', kind: 'number' },
      { key: 'fee', label: 'Entry fee', kind: 'text' },
      { key: 'eligibility', label: 'Eligibility', kind: 'text' },
      { key: 'description', label: 'Description', kind: 'longtext' },
      { key: 'registrationLink', label: 'Registration link', kind: 'url' },
      { key: 'poster', label: 'Poster / cover image', kind: 'image' },
    ],
  },
  ...interests([
    ['publish', 'Publish events on PL4Y'],
    ['participants', 'Acquire participants'],
    ['registrations', 'Collect event registrations'],
    ['promote', 'Promote tournaments'],
    ['communities', 'Build sports communities'],
    ['venues', 'Find venue partners'],
  ]),
  { key: 'futureRegistrations', label: 'Would use PL4Y for future registrations', kind: 'choice', options: YES_MAYBE_NO },
];

const AMBASSADOR: readonly Field[] = [
  { key: 'fullName', label: 'Full name', kind: 'text', required: true },
  { key: 'college', label: 'College / university', kind: 'text' },
  { key: 'city', label: 'City', kind: 'text', required: true },
  {
    key: 'year',
    label: 'Year of study',
    kind: 'choice',
    options: [
      ['1', 'First year'],
      ['2', 'Second year'],
      ['3', 'Third year'],
      ['4', 'Fourth year'],
      ['5+', 'Fifth year or later'],
      ['pg', 'Postgraduate'],
      ['none', 'Not a student'],
    ],
  },
  { key: 'instagram', label: 'Instagram', kind: 'text' },
  { key: 'linkedin', label: 'LinkedIn', kind: 'text' },
  ...sports(),
  { key: 'groups', label: 'Groups or communities they can reach', kind: 'longtext' },
  { key: 'reach', label: 'Potential reach (people)', kind: 'number' },
  { key: 'experience', label: 'Event or community-building experience', kind: 'longtext' },
  { key: 'promotionPlan', label: 'How they would promote PL4Y', kind: 'longtext', required: true },
  {
    key: 'availability',
    label: 'Weekly availability',
    kind: 'choice',
    options: [
      ['lt2', 'Under 2 hours'],
      ['2-5', '2–5 hours'],
      ['5-10', '5–10 hours'],
      ['10+', 'More than 10 hours'],
    ],
  },
  {
    key: 'contributionModel',
    label: 'Preferred contribution model',
    kind: 'choice',
    options: [
      ['volunteer', 'Volunteer'],
      ['referral', 'Referral incentives'],
      ['paid', 'Paid role'],
      ['open', 'Open to discussion'],
    ],
  },
];

const BRAND: readonly Field[] = [
  { key: 'brandName', label: 'Brand name', kind: 'text', required: true },
  { key: 'brandCategory', label: 'Brand category', kind: 'text' },
  { key: 'website', label: 'Website', kind: 'url' },
  { key: 'links', label: 'Social media links', kind: 'longtext' },
  { key: 'objectives', label: 'Marketing objectives', kind: 'longtext', required: true },
  { key: 'audience', label: 'Target audience', kind: 'longtext' },
  {
    key: 'collabTypes',
    label: 'Collaboration types',
    kind: 'multi',
    options: [
      ['campaigns', 'Campaigns'],
      ['activations', 'Community activations'],
      ['events', 'Sports events'],
      ['offers', 'Offers'],
      ['products', 'Product partnerships'],
      ['other', 'Other'],
    ],
  },
  {
    key: 'scope',
    label: 'Geographic scope',
    kind: 'choice',
    options: [
      ['city', 'One city'],
      ['cities', 'Several cities'],
      ['national', 'National'],
      ['international', 'International'],
    ],
  },
  { key: 'timeline', label: 'Proposed campaign timeline', kind: 'text' },
  {
    key: 'budget',
    label: 'Indicative budget',
    kind: 'choice',
    options: [
      ['lt50k', 'Under ₹50,000'],
      ['50k-2l', '₹50,000 – ₹2 lakh'],
      ['2l-10l', '₹2 lakh – ₹10 lakh'],
      ['10l+', 'More than ₹10 lakh'],
      ['undisclosed', 'Prefer not to say'],
    ],
  },
  { key: 'expectations', label: 'What the brand expects from PL4Y', kind: 'longtext' },
  { key: 'requirements', label: 'Additional requirements', kind: 'longtext' },
];

const OTHER: readonly Field[] = [
  { key: 'profile', label: 'About the organisation or person', kind: 'longtext', required: true },
  { key: 'proposal', label: 'Proposed partnership', kind: 'longtext', required: true },
  { key: 'opportunity', label: 'Opportunity it creates', kind: 'longtext' },
  { key: 'contribution', label: 'What they can contribute', kind: 'longtext' },
  { key: 'needs', label: 'What they need from PL4Y', kind: 'longtext' },
  { key: 'timeline', label: 'Proposed timeline', kind: 'text' },
  { key: 'links', label: 'Supporting links', kind: 'longtext' },
  { key: 'files', label: 'Supporting images', kind: 'images' },
];

export const SECTIONS: Record<Category, readonly Field[]> = {
  community: COMMUNITY,
  college: COLLEGE,
  venue: VENUE,
  events: EVENTS,
  ambassador: AMBASSADOR,
  brand: BRAND,
  other: OTHER,
};
