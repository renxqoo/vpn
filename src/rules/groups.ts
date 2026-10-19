/**
 * 策略组（design.md §1.5）：select / url-test / fallback。
 * 组实现 Outbound 接口——组即出口（chains 展开）。
 */

import { logger } from '../core/log.ts';
import type { SocksAddr } from '../core/socksaddr.ts';
import type { Conn, Outbound } from '../core/types.ts';
import type { ProxyGroupConfig } from '../config/clash.ts';

const log = logger('group');

export type ProxyOrGroup = Outbound & { kind?: 'proxy' | 'group'; typeName?: string };

export class SelectGroup implements Outbound {
  readonly name: string;
  kind = 'group' as const;
  typeName = 'Selector';
  private members: Map<string, Outbound>;
  private now: string;

  constructor(name: string, members: Map<string, Outbound>, initial: string) {
    this.name = name;
    this.members = members;
    this.now = initial;
  }

  current(): string {
    return this.now;
  }

  select(name: string): boolean {
    if (!this.members.has(name)) return false;
    this.now = name;
    log.info(`[${this.name}] select -> ${name}`);
    return true;
  }

  memberNames(): string[] {
    return [...this.members.keys()];
  }

  connect(target: SocksAddr): Promise<Conn> {
    const picked = this.members.get(this.now);
    if (!picked) return Promise.reject(new Error(`group '${this.name}' has no member '${this.now}'`));
    return picked.connect(target);
  }

  close(): void {
    for (const m of this.members.values()) m.close();
  }
}

/** 定时探测选路（url-test 选最快；fallback 依序选第一个可用） */
export class AutoGroup implements Outbound {
  readonly name: string;
  kind = 'group' as const;
  typeName: string;
  private members: Map<string, Outbound>;
  private order: string[];
  private type: 'url-test' | 'fallback';
  private url: string;
  private intervalMs: number;
  private toleranceMs: number;
  private currentName: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history = new Map<string, number[]>(); // member → 最近延迟

  constructor(cfg: ProxyGroupConfig, members: Map<string, Outbound>) {
    this.name = cfg.name;
    this.members = members;
    this.order = cfg.proxies;
    this.type = cfg.type === 'fallback' ? 'fallback' : 'url-test';
    this.typeName = cfg.type === 'fallback' ? 'URLFallback' : 'URLTest';
    this.url = cfg.url ?? 'http://cp.cloudflare.com/generate204';
    this.intervalMs = (cfg.interval ?? 300) * 1000;
    this.toleranceMs = cfg.tolerance ?? 50;
    this.currentName = this.order.find((m) => members.has(m)) ?? '';
  }

  current(): string {
    return this.currentName;
  }

  memberNames(): string[] {
    return [...this.order];
  }

  delays(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const name of this.order) {
      const h = this.history.get(name);
      out[name] = h && h.length > 0 ? (h[h.length - 1] as number) : null;
    }
    return out;
  }

  async probeAll(timeoutMs = 5000): Promise<void> {
    const results = await Promise.all(
      this.order.map(async (name) => {
        const m = this.members.get(name);
        if (!m || !m.probe) return [name, null] as const;
        const d = await m.probe(this.url, timeoutMs);
        return [name, d] as const;
      }),
    );
    for (const [name, delay] of results) {
      const h = this.history.get(name) ?? [];
      h.push(delay ?? -1);
      if (h.length > 10) h.shift();
      this.history.set(name, h);
    }
    this.pick();
  }

  private pick(): void {
    if (this.type === 'url-test') {
      let bestName = '';
      let best = Infinity;
      for (const [name, h] of this.history) {
        const last = h[h.length - 1];
        if (last === undefined || last < 0) continue;
        if (last < best - this.toleranceMs) {
          best = last;
          bestName = name;
        }
      }
      if (bestName && bestName !== this.currentName) {
        log.info(`[${this.name}] url-test -> ${bestName} (${best}ms)`);
        this.currentName = bestName;
      }
      if (!this.currentName) this.currentName = this.order[0] ?? '';
    } else {
      for (const name of this.order) {
        const h = this.history.get(name);
        const last = h?.[h.length - 1];
        if (last !== undefined && last >= 0) {
          if (name !== this.currentName) {
            log.info(`[${this.name}] fallback -> ${name}`);
            this.currentName = name;
          }
          return;
        }
      }
    }
  }

  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => void this.probeAll(), this.intervalMs);
  }

  connect(target: SocksAddr): Promise<Conn> {
    const picked =
      this.members.get(this.currentName) ??
      this.members.get(this.order.find((m) => this.members.has(m)) ?? '');
    if (!picked) return Promise.reject(new Error(`group '${this.name}' empty`));
    return picked.connect(target);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const m of this.members.values()) m.close();
  }
}

export function buildGroup(
  cfg: ProxyGroupConfig,
  members: Map<string, Outbound>,
): SelectGroup | AutoGroup {
  if (cfg.type === 'select') {
    const initial = cfg.proxies.find((m) => members.has(m)) ?? '';
    return new SelectGroup(cfg.name, members, initial);
  }
  const g = new AutoGroup(cfg, members);
  return g;
}
