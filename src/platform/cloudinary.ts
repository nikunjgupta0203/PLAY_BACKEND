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
  /** org — an organisation's logo lives under its own root, checked the same way. */
  organisationRoot: (organisationId: string) => `pl4y/organisations/${organisationId}`,
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

export const cloudinary = { TRANSFORMS, folders, signUpload, url, destroy };
export type Cloudinary = typeof cloudinary;
