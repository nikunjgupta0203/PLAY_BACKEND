/**
 * Speed — a read cache that lives for one GraphQL request (conventions.md §4:
 * nothing is cached across requests, so nothing leaks between users).
 *
 * A screen's resolvers ask for the same rows many times — a player profile's
 * stats, results and messaging fields each read the profile and the viewer
 * again. Every repeat is a round trip to the database's region. `memo` turns
 * the repeats into one read.
 *
 * Only QUERIES are cached. A mutation reads, writes, then reads again, and the
 * second read must see the write — so `memo` is a plain call until
 * `enableReadCache` runs, which app.ts does once Apollo knows the operation is
 * a query. Outside a request (the worker, scripts, tests) it is a plain call too.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface Store {
  enabled: boolean;
  reads: Map<string, Promise<unknown>>;
}

const als = new AsyncLocalStorage<Store>();

/** Runs `fn` (an Express `next`) with a fresh, disabled cache. */
export function withRequestCache<T>(fn: () => T): T {
  return als.run({ enabled: false, reads: new Map() }, fn);
}

/** The operation is a query: repeated reads may share one result from here on. */
export function enableReadCache(): void {
  const store = als.getStore();
  if (store) store.enabled = true;
}

/** `load()`, read once per request under `key` when the cache is on. A failed read is not kept. */
export function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store?.enabled) return load();
  const hit = store.reads.get(key);
  if (hit) return hit as Promise<T>;
  const p = load();
  store.reads.set(key, p);
  p.catch(() => store.reads.delete(key));
  return p;
}

/** Seeds a result read another way (a profile found by user id is also found by its id). */
export function remember<T>(key: string, value: T): void {
  const store = als.getStore();
  if (store?.enabled && !store.reads.has(key)) store.reads.set(key, Promise.resolve(value));
}
