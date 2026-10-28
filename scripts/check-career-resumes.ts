/**
 * careers R5 — checks, against the real Cloudinary account, that a resume can
 * be uploaded as a private file, is NOT reachable by its public URL, can be
 * read through the expiring download link, and can be deleted. Uploads a tiny
 * test PDF and deletes it again.
 *
 *   npx tsx --env-file=.env scripts/check-career-resumes.ts
 */
import { randomUUID } from 'node:crypto';
import { cloudinary } from '../src/platform/cloudinary.js';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const sig = cloudinary.signPrivateUpload({ publicId: `${randomUUID()}.pdf`, folder: `pl4y/careers/check-${randomUUID()}` });
const form = new FormData();
form.set('file', new Blob([pdf], { type: 'application/pdf' }), 'check.pdf');
const fields = {
  api_key: sig.apiKey,
  timestamp: String(sig.timestamp),
  signature: sig.signature,
  public_id: sig.publicId,
  folder: sig.folder,
  upload_preset: sig.uploadPreset,
  type: sig.type,
};
for (const [k, v] of Object.entries(fields)) form.set(k, v);

const up = await fetch(sig.uploadUrl, { method: 'POST', body: form });
const body = (await up.json()) as { public_id?: string; type?: string; secure_url?: string; error?: { message?: string } };
if (!up.ok || !body.public_id) {
  console.error('FAIL upload:', up.status, body.error?.message ?? body);
  process.exit(1);
}
const id = body.public_id;
const results: [string, boolean][] = [];
results.push(['stored as private', body.type === 'private']);
results.push(['size readable', (await cloudinary.privateFileBytes(id)) === pdf.length]);
results.push(['public URL blocked', body.secure_url ? (await fetch(body.secure_url)).status >= 400 : true]);
const dl = await fetch(cloudinary.privateDownloadUrl(id));
results.push(['download link works', dl.ok && (await dl.arrayBuffer()).byteLength === pdf.length]);
await cloudinary.destroyPrivate(id);
results.push(['deleted', (await cloudinary.privateFileBytes(id)) === null]);

for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
