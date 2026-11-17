/**
 * A DataLoader that lives and dies with one request, for a module whose batch
 * reads are not worth a slot in `Loaders` (conventions.md §4: no cross-request
 * cache). Keyed on the context object, so it is garbage once the request ends.
 */
import DataLoader from 'dataloader';
import type { Ctx } from './context.js';

const perRequest = new WeakMap<Ctx, Map<string, DataLoader<unknown, unknown, unknown>>>();

export function requestLoader<K, V>(
  ctx: Ctx,
  name: string,
  batch: (keys: readonly K[]) => Promise<V[]>,
  cacheKeyFn?: (key: K) => string,
): DataLoader<K, V, unknown> {
  let loaders = perRequest.get(ctx);
  if (!loaders) {
    loaders = new Map();
    perRequest.set(ctx, loaders);
  }
  let loader = loaders.get(name) as DataLoader<K, V, unknown> | undefined;
  if (!loader) {
    loader = new DataLoader<K, V, unknown>(batch, cacheKeyFn ? { cacheKeyFn } : {});
    loaders.set(name, loader as unknown as DataLoader<unknown, unknown, unknown>);
  }
  return loader;
}
