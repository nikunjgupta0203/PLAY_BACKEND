/**
 * CI guards for rules that are cheap to state and expensive to discover broken.
 *   · process.env outside config.ts        (platform R1)
 *   · pg_advisory_lock / bare SET          (ADR 0001 §C3 — leaks under PgBouncer)
 *   · Cloudinary URLs built by hand        (ADR 0003 §C1)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
// .worktrees holds other branches' checkouts; each is guarded on its own.
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

interface Violation { file: string; line: number; rule: string; text: string }
const violations: Violation[] = [];

const CONFIG = join('src', 'platform', 'config.ts');
const TOKENS = join('src', 'platform', 'cloudinary.ts');

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  const isTs = file.endsWith('.ts');
  const isSql = file.endsWith('.sql');
  if (!isTs && !isSql) continue;
  // Docs quote the forbidden forms in order to forbid them.
  if (rel.split(sep)[0] === 'docs') continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    const line = i + 1;
    const t = text.trimStart();
    if (t.startsWith('//') || t.startsWith('--') || t.startsWith('*') || t.startsWith('/*')) return;

    // Only src/ is bound by R1. tests/setup.ts exists to populate the env,
    // and scripts/ run before the app is composed.
    const inSrc = rel.split(sep)[0] === 'src';
    if (isTs && inSrc && /process\.env/.test(text) && rel !== CONFIG && !/eslint-disable/.test(lines[i - 1] ?? '')) {
      violations.push({ file: rel, line, rule: 'platform R1: process.env outside config.ts', text });
    }
    if (/\bpg_advisory_lock\s*\(/.test(text)) {
      violations.push({ file: rel, line, rule: 'ADR 0001 C3: use pg_advisory_xact_lock', text });
    }
    // A SET clause continuing an UPDATE on the line above is not a session SET.
    const continuesUpdate = /^\s*UPDATE\b/i.test(lines[i - 1] ?? '');
    if (isSql && /^\s*SET\s+(?!LOCAL)/i.test(text) && !continuesUpdate) {
      violations.push({ file: rel, line, rule: 'ADR 0001 C3: use SET LOCAL', text });
    }
    if (isTs && /res\.cloudinary\.com/.test(text) && rel !== TOKENS) {
      violations.push({ file: rel, line, rule: 'ADR 0003 C1: build URLs via platform/cloudinary.ts', text });
    }
  });
}

if (violations.length > 0) {
  console.error(`\n${violations.length} guard violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.rule}\n    ${v.text.trim()}\n`);
  }
  process.exit(1);
}
console.log('Guards clean.');
