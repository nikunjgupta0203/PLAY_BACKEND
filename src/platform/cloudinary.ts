/**
 * Cloudinary (ADR 0003). The ONLY place a delivery URL is built and the ONLY
 * place the API secret is used — scripts/guard.ts fails the build if
 * `res.cloudinary.com` appears anywhere else.
 *
 * We store `public_id`, never a URL: a persisted URL freezes a transformation,
 * a delivery host and a version into the database, and all three will change
 * (ADR 0003 §C3).
 */
import { createHash } from 'node:crypto';
import { config, requireKeys } from './config.js';

/**
 * ADR 0003 §C1 — named transformations, defined in the Cloudinary console and
 * referenced by name. Never an ad-hoc `w_237` string: distinct derivatives are
 * billed the first time each is generated, and a size change should be a
 * console edit rather than a mobile release.
 */
export const TRANSFORMS = {
  avatarSm: 't_avatar_sm',
  avatarMd: 't_avatar_md',
  avatarLg: 't_avatar_lg',
  eventCover: 't_event_cover',
  eventThumb: 't_event_thumb',
  venuePhoto: 't_venue_photo',
} as const;

export type TransformName = (typeof TRANSFORMS)[keyof typeof TRANSFORMS];

/** ADR 0003 §C5 — folders are part of the public_id and painful to reorganise. */
export const folders = {
  avatar: (playerId: string) => `pl4y/avatars/${playerId}`,
  eventCover: (eventId: string) => `pl4y/events/${eventId}/cover`,
  eventGallery: (eventId: string, n: number) => `pl4y/events/${eventId}/gallery/${n}`,
  venuePhoto: (venueId: string, n: number) => `pl4y/venues/${venueId}/${n}`,
  /**
   * The prefix every asset for one owner shares. A caller that issued a
   * signature checks the public_id it gets back against this: without that
   * check a client can upload under our signature and then report somebody
   * else’s asset (ADR 0003 §C2 — the step teams skip).
   */
  venueRoot: (venueId: string) => `pl4y/venues/${venueId}`,
  eventRoot: (eventId: string) => `pl4y/events/${eventId}`,
  /** venue hosts R8 — an applicant's venue photos, before there is a venue to own them. */
  venueHostRoot: (userId: string) => `pl4y/venue-hosts/${userId}`,
  /** org — an organisation's logo lives under its own root, checked the same way. */
  organisationRoot: (organisationId: string) => `pl4y/organisations/${organisationId}`,
  /** partnerships R5 — one attempt at the partnership form: its logo, venue photos and posters. */
  partnershipRoot: (clientToken: string) => `pl4y/partners/${clientToken}`,
  /** communities — a community's cover, checked against this root the same way. */
  communityRoot: (communityId: string) => `pl4y/communities/${communityId}`,
  /** careers R5 — one attempt at the careers form: its resume, stored private. */
  careerRoot: (clientToken: string) => `pl4y/careers/${clientToken}`,
};

export interface UploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  publicId: string;
  folder: string;
  uploadPreset: string;
  signature: string;
  /** Where the client PUTs the file. */
  uploadUrl: string;
  expiresAt: Date;
}

/** Cloudinary signs the sorted, `&`-joined params plus the API secret, SHA-1. */
function sign(params: Record<string, string | number>): string {
  requireKeys('Cloudinary', ['CLOUDINARY_API_SECRET']);
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  return createHash('sha1')
    .update(canonical + config.CLOUDINARY_API_SECRET)
    .digest('hex');
}

/**
 * ADR 0003 §C2 — the client never holds the secret and never uploads under an
 * unsigned preset, which would be an open door to arbitrary uploads billed to
 * us. The caller must persist `publicId` and compare it to what the client
 * hands back: without that check a client can upload under our signature and
 * then report somebody else's asset.
 */
export function signUpload(opts: {
  publicId: string;
  folder: string;
  now?: Date;
  /** Cloudinary rejects a signature older than an hour; we are stricter. */
  ttlSeconds?: number;
}): UploadSignature {
  requireKeys('Cloudinary', [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_UPLOAD_PRESET',
  ]);

  const now = opts.now ?? new Date();
  const ttl = opts.ttlSeconds ?? 600;
  const timestamp = Math.floor(now.getTime() / 1000);
  const params = {
    folder: opts.folder,
    public_id: opts.publicId,
    timestamp,
    upload_preset: config.CLOUDINARY_UPLOAD_PRESET,
  };

  return {
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    apiKey: config.CLOUDINARY_API_KEY,
    timestamp,
    publicId: opts.publicId,
    folder: opts.folder,
    uploadPreset: config.CLOUDINARY_UPLOAD_PRESET,
    signature: sign(params),
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/upload`,
    expiresAt: new Date(now.getTime() + ttl * 1000),
  };
}

/** ADR 0003 §C1, §C3 — built at render, from a named transformation, here only. */
export function url(publicId: string | null, transform: TransformName): string | null {
  if (!publicId) return null;
  const cloud = config.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return null;
  return `https://res.cloudinary.com/${cloud}/image/upload/${transform}/${publicId}`;
}

/**
 * ADR 0003 §C4 — replacing an avatar destroys the old asset. An orphan is
 * storage we are billed for and nothing references.
 */
export async function destroy(publicId: string, now = new Date()): Promise<void> {
  requireKeys('Cloudinary', [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ]);
  const timestamp = Math.floor(now.getTime() / 1000);
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    api_key: config.CLOUDINARY_API_KEY,
    signature: sign({ public_id: publicId, timestamp }),
  });
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/destroy`,
    { method: 'POST', body },
  );
  if (!res.ok) {
    throw new Error(`Cloudinary destroy failed: ${res.status} ${await res.text()}`);
  }
}

// --- private documents (careers resumes) -------------------------------------
//
// A resume is personal data, so it is never a public asset: it is uploaded as
// a `raw` file of type `private`, which Cloudinary serves only through a
// signed, expiring download link made here for signed-in staff.

const KEYS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const;

export interface PrivateUploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  publicId: string;
  folder: string;
  uploadPreset: string;
  /** Always "private". Sent with the file; it is part of the signature. */
  type: 'private';
  signature: string;
  uploadUrl: string;
  expiresAt: Date;
}

/** Like signUpload, for one private raw file (a PDF). The caller checks the public_id that comes back. */
export function signPrivateUpload(opts: { publicId: string; folder: string; now?: Date; ttlSeconds?: number }): PrivateUploadSignature {
  requireKeys('Cloudinary', [...KEYS, 'CLOUDINARY_UPLOAD_PRESET']);
  const now = opts.now ?? new Date();
  const ttl = opts.ttlSeconds ?? 600;
  const timestamp = Math.floor(now.getTime() / 1000);
  const params = {
    folder: opts.folder,
    public_id: opts.publicId,
    timestamp,
    type: 'private',
    upload_preset: config.CLOUDINARY_UPLOAD_PRESET,
  };
  return {
    cloudName: config.CLOUDINARY_CLOUD_NAME,
    apiKey: config.CLOUDINARY_API_KEY,
    timestamp,
    publicId: opts.publicId,
    folder: opts.folder,
    uploadPreset: config.CLOUDINARY_UPLOAD_PRESET,
    type: 'private',
    signature: sign(params),
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/raw/upload`,
    expiresAt: new Date(now.getTime() + ttl * 1000),
  };
}

/** A download link for a private raw file that stops working after `ttlSeconds`. */
export function privateDownloadUrl(publicId: string, opts: { ttlSeconds?: number; now?: Date } = {}): string {
  requireKeys('Cloudinary', [...KEYS]);
  const now = opts.now ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const params = { public_id: publicId, type: 'private', timestamp, expires_at: timestamp + (opts.ttlSeconds ?? 300) };
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    api_key: config.CLOUDINARY_API_KEY,
    signature: sign(params),
  });
  return `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/raw/download?${query.toString()}`;
}

const adminAuth = () => `Basic ${Buffer.from(`${config.CLOUDINARY_API_KEY}:${config.CLOUDINARY_API_SECRET}`).toString('base64')}`;

/**
 * The size of a private raw file, or null when Cloudinary has no such file.
 * Throws when Cloudinary cannot be asked (network, outage): the caller decides.
 */
export async function privateFileBytes(publicId: string): Promise<number | null> {
  requireKeys('Cloudinary', [...KEYS]);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/resources/raw/private/${publicId.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { authorization: adminAuth() } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloudinary lookup failed: ${res.status}`);
  const body = (await res.json()) as { bytes?: number };
  return typeof body.bytes === 'number' ? body.bytes : null;
}

/** Deletes a private raw file. Gone already counts as done. */
export async function destroyPrivate(publicId: string, now = new Date()): Promise<void> {
  requireKeys('Cloudinary', [...KEYS]);
  const timestamp = Math.floor(now.getTime() / 1000);
  const params = { public_id: publicId, timestamp, type: 'private' };
  const body = new URLSearchParams({
    public_id: publicId,
    timestamp: String(timestamp),
    type: 'private',
    api_key: config.CLOUDINARY_API_KEY,
    signature: sign(params),
  });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/raw/destroy`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Cloudinary destroy failed: ${res.status} ${await res.text()}`);
}

export const cloudinary = {
  TRANSFORMS,
  folders,
  signUpload,
  url,
  destroy,
  signPrivateUpload,
  privateDownloadUrl,
  privateFileBytes,
  destroyPrivate,
};
export type Cloudinary = typeof cloudinary;
