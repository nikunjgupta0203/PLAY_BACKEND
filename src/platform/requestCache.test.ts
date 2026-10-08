import { describe, expect, it, vi } from 'vitest';
import { enableReadCache, memo, remember, withRequestCache } from './requestCache.js';

const counting = () => {
  const load = vi.fn(async () => ({ n: load.mock.calls.length }));
  return load;
};

describe('requestCache', () => {
  it('outside a request every call reads (the worker, scripts, tests)', async () => {
    const load = counting();
    await memo('k', load);
    await memo('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('inside a request but before enableReadCache (a mutation) every call reads', async () => {
    const load = counting();
    await withRequestCache(async () => {
      await memo('k', load);
      await memo('k', load);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a query reads each key once, including calls that overlap', async () => {
    const load = counting();
    const results = await withRequestCache(async () => {
      enableReadCache();
      return Promise.all([memo('k', load), memo('k', load), memo('other', load)]);
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(results[0]).toBe(results[1]);
  });

  it('two requests never share a read', async () => {
    const load = counting();
    const one = () =>
      withRequestCache(async () => {
        enableReadCache();
        return memo('k', load);
      });
    await Promise.all([one(), one()]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not kept: the next call tries again', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('down');
      return 'ok';
    });
    await withRequestCache(async () => {
      enableReadCache();
      await expect(memo('k', load)).rejects.toThrow('down');
      fail = false;
      expect(await memo('k', load)).toBe('ok');
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('remember seeds a key only while the cache is on', async () => {
    const load = counting();
    await withRequestCache(async () => {
      remember('k', { n: -1 });
      expect(await memo('k', load)).toEqual({ n: 1 }); // off: not seeded, read
      enableReadCache();
      remember('j', { n: -1 });
      expect(await memo('j', load)).toEqual({ n: -1 });
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
