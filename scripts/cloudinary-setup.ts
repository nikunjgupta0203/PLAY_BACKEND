/**
 * `pnpm cloudinary:setup` — creates the named transformations ADR 0003 §C1
 * lists, and the signed upload preset §C2 requires, in the Cloudinary account
 * `.env` points at. Every URL the API builds (`platform/cloudinary.ts#url`)
 * references a transformation by name, so an account without them serves a
 * 404 for every avatar, cover and venue photo. `signUpload` signs
 * `upload_preset` into every request, so an account without the preset fails
 * every upload with "Invalid Signature" — this is also what fills in
 * CLOUDINARY_UPLOAD_PRESET, which `.env.example` otherwise leaves blank.
 *
 * Idempotent: an existing transformation or preset is left exactly as it is.
 */
import { config } from '../src/platform/config.js';

/** ADR 0003 §C1 — the table, verbatim. */
const NAMED: Record<string, string> = {
  avatar_sm: 'c_fill,g_face,w_32,h_32,f_auto,q_auto',
  avatar_md: 'c_fill,g_face,w_96,h_96,f_auto,q_auto',
  avatar_lg: 'c_fill,g_face,w_160,h_160,f_auto,q_auto',
  event_cover: 'c_fill,w_1200,h_630,f_auto,q_auto',
  event_thumb: 'c_fill,w_400,h_225,f_auto,q_auto',
  venue_photo: 'c_fill,w_800,h_600,f_auto,q_auto',
};

/** ADR 0003 §C2 — signed, never unsigned: the API secret authorizes every upload. */
const UPLOAD_PRESET_NAME = 'pl4y_signed';

const cloud = config.CLOUDINARY_CLOUD_NAME;
if (!cloud || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
  console.error('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET first.');
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${config.CLOUDINARY_API_KEY}:${config.CLOUDINARY_API_SECRET}`).toString('base64')}`;
const base = `https://api.cloudinary.com/v1_1/${cloud}/transformations`;

for (const [name, transformation] of Object.entries(NAMED)) {
  const existing = await fetch(`${base}/${name}`, { headers: { authorization: auth } });
  if (existing.ok) {
    console.log(`t_${name}: exists, left alone`);
    continue;
  }
  const res = await fetch(`${base}/${name}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ transformation }),
  });
  if (!res.ok) {
    console.error(`t_${name}: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`t_${name}: created (${transformation})`);
}

const presetsBase = `https://api.cloudinary.com/v1_1/${cloud}/upload_presets`;
const existingPreset = await fetch(`${presetsBase}/${UPLOAD_PRESET_NAME}`, { headers: { authorization: auth } });
if (existingPreset.ok) {
  console.log(`upload_preset ${UPLOAD_PRESET_NAME}: exists, left alone`);
} else {
  const res = await fetch(presetsBase, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: UPLOAD_PRESET_NAME, unsigned: 'false' }),
  });
  if (!res.ok) {
    console.error(`upload_preset ${UPLOAD_PRESET_NAME}: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
  } else {
    console.log(`upload_preset ${UPLOAD_PRESET_NAME}: created`);
    console.log(`Set CLOUDINARY_UPLOAD_PRESET="${UPLOAD_PRESET_NAME}" in .env, then restart the API.`);
  }
}
