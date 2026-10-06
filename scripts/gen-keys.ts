/**
 * Generate a dev RS256 keypair and write it into .env (identity R5).
 *
 * Keys are stored base64-encoded: a PEM's newlines do not survive .env files,
 * shells and CI secret stores reliably, and every escaping scheme has an edge
 * that bites at the worst moment. One line, no escaping.
 *
 *   npm run keys:dev
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const b64 = (pem: string) => Buffer.from(pem.trim(), 'utf8').toString('base64');

const target = '.env';
if (!existsSync(target)) {
  console.error('No .env found. Copy .env.example to .env first.');
  process.exit(1);
}

const lines = readFileSync(target, 'utf8').split(/\r?\n/);
const out: string[] = [];
let skipping = false;

for (const line of lines) {
  // Drop any previous multi-line PEM block left by an older version.
  if (skipping) {
    if (line.includes('-----END')) skipping = false;
    continue;
  }
  if (/^JWT_PRIVATE_KEY=/.test(line)) {
    out.push(`JWT_PRIVATE_KEY="${b64(privateKey)}"`);
    if (line.includes('-----BEGIN') && !line.includes('-----END')) skipping = true;
    continue;
  }
  if (/^JWT_PUBLIC_KEY=/.test(line)) {
    out.push(`JWT_PUBLIC_KEY="${b64(publicKey)}"`);
    if (line.includes('-----BEGIN') && !line.includes('-----END')) skipping = true;
    continue;
  }
  out.push(line);
}

writeFileSync(target, out.join('\n'));
console.log('Wrote a fresh base64-encoded RS256 keypair into .env');
