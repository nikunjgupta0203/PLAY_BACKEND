/**
 * Load .env into the test process before any module reads config.
 * setupFiles run before the test file is imported, which is what platform R2
 * needs: config validates at import time and exits if anything is missing.
 */
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const raw = (m[2] ?? '').trim();
    let value: string;
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      // Quoted: take everything up to the matching close, ignore any trailing
      // `# comment` that follows it.
      const close = raw.indexOf(quote, 1);
      value = close === -1 ? raw.slice(1) : raw.slice(1, close);
    } else {
      value = raw.replace(/\s+#.*$/, '').trim();
    }
    process.env[m[1]] ??= value;
  }
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
