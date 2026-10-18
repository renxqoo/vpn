/** 订阅拉取与缓存（design.md §1.5/D7）：线上优先、缓存兜底。 */

import { join } from 'node:path';
import { logger } from '../core/log.ts';

const log = logger('config:subscription');

export interface SubscriptionStore {
  cachePath: string | null;
  fetch(url: string): Promise<string>;
}

export async function loadSubscription(url: string, store: SubscriptionStore): Promise<string> {
  try {
    const text = await store.fetch(url);
    if (store.cachePath) {
      await Bun.write(store.cachePath, text).catch(() => {});
    }
    log.info(`subscription fetched (${text.length} bytes)`);
    return text;
  } catch (e) {
    log.warn(`subscription fetch failed: ${String(e).slice(0, 80)}`);
    if (store.cachePath) {
      const f = Bun.file(store.cachePath);
      if (await f.exists()) {
        const text = await f.text();
        log.info('using cached subscription');
        return text;
      }
    }
    throw new Error(`subscription unavailable: ${String(e).slice(0, 80)}`);
  }
}

/** 生产 store：真实 fetch（clash UA）+ .cache/sub.yaml */
export function defaultStore(cacheDir: string): SubscriptionStore {
  return {
    cachePath: join(cacheDir, 'sub.yaml'),
    async fetch(u: string): Promise<string> {
      const r = await fetch(u, { headers: { 'user-agent': 'clash-verge/v2.0.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
  };
}
