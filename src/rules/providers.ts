/**
 * rule-providers 拉取/缓存/解析（design.md §1.5）：payload 列表 → domain/ipcidr/classical。
 * 文本格式自动识别（payload: 头存在 = yaml 列表，否则每行一条）。
 */

import { logger } from '../core/log.ts';
import { parseYaml, asMap, asSeq, asStr, type YamlValue } from '../config/yaml.ts';
import type { RuleProviderConfig } from '../config/clash.ts';
import { parseRuleLine } from '../config/clash.ts';
import type { CidrRule, DomainSet, ResolvedRuleSet } from './index.ts';
import { parseCidr } from './index.ts';

const log = logger('rules:providers');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export interface ProviderStore {
  cacheDir(): string | null;
  fetch(url: string): Promise<string>;
  readFile(path: string): Promise<string | null>;
  now(): number;
}

export class RuleProviders {
  private configs: Map<string, RuleProviderConfig>;
  private store: ProviderStore;
  private runtime = new Map<string, { resolved: ResolvedRuleSet; loadedAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(configs: Map<string, RuleProviderConfig>, store: ProviderStore) {
    this.configs = configs;
    this.store = store;
  }

  /** 启动时加载全部：并行拉取（每个 15s 超时；缓存可用；全失败空集 + 警告，不阻塞启动） */
  async loadAll(): Promise<void> {
    await Promise.all([...this.configs.entries()].map(([name, cfg]) => this.loadOne(name, cfg)));
    const intervals = [...this.configs.values()].map((c) => c.interval);
    const minInterval = Math.min(...intervals.filter((n) => Number.isFinite(n)), 86400);
    if (intervals.length > 0) {
      this.timer = setInterval(() => {
        void this.refreshDue();
      }, minInterval * 1000);
    }
  }

  private async refreshDue(): Promise<void> {
    const now = this.store.now();
    for (const [name, cfg] of this.configs) {
      const rt = this.runtime.get(name);
      if (!rt || now - rt.loadedAt >= cfg.interval * 1000) {
        await this.loadOne(name, cfg, true);
      }
    }
  }

  private async loadOne(name: string, cfg: RuleProviderConfig, isRefresh = false): Promise<void> {
    let text: string | null = null;
    if (cfg.url) {
      try {
        text = await withTimeout(this.store.fetch(cfg.url), 15000);
        await this.persistCache(name, text);
      } catch (e) {
        if (!isRefresh) log.warn(`provider '${name}': fetch failed (${String(e).slice(0, 60)}), trying cache`);
      }
    }
    if (text === null && cfg.path) {
      text = await this.store.readFile(cfg.path).catch(() => null);
    }
    if (text === null) {
      text = await this.readCache(name);
    }
    if (text === null) {
      log.warn(`provider '${name}': no source available, rules from this set will not match`);
      this.runtime.set(name, { resolved: {}, loadedAt: this.store.now() });
      return;
    }
    try {
      const resolved = parseProviderPayload(text, cfg.behavior);
      this.runtime.set(name, { resolved, loadedAt: this.store.now() });
    } catch (e) {
      log.warn(`provider '${name}': parse failed (${String(e).slice(0, 80)})`);
      if (!this.runtime.has(name)) this.runtime.set(name, { resolved: {}, loadedAt: this.store.now() });
    }
  }

  private cachePath(name: string): string | null {
    const dir = this.store.cacheDir();
    if (!dir) return null;
    return `${dir}/ruleset-${name}.txt`;
  }

  private async persistCache(name: string, text: string): Promise<void> {
    const p = this.cachePath(name);
    if (!p) return;
    await Bun.write(p, text).catch(() => {});
  }

  private async readCache(name: string): Promise<string | null> {
    const p = this.cachePath(name);
    if (!p) return null;
    const f = Bun.file(p);
    if (!(await f.exists())) return null;
    return f.text().catch(() => null);
  }

  getRuntime(): Map<string, { resolved: ResolvedRuleSet }> {
    const out = new Map<string, { resolved: ResolvedRuleSet }>();
    for (const [k, v] of this.runtime) out.set(k, { resolved: v.resolved });
    return out;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 解析 payload 内容（yaml `payload: [...]` 或纯文本每行一条） */
export function parseProviderPayload(text: string, behavior: RuleProviderConfig['behavior']): ResolvedRuleSet {
  const entries = extractEntries(text);
  if (behavior === 'domain') {
    const set: DomainSet = { suffixes: new Set(), exact: new Set(), keywords: new Set() };
    for (const e of entries) {
      const v = e.trim();
      if (!v) continue;
      if (v.startsWith('+.')) {
        set.suffixes.add(v.slice(2));
      } else if (v.startsWith('.')) {
        set.suffixes.add(v.slice(1));
      } else if (v.includes('*')) {
        // '*.example.com' 形态归一化为 keyword 近似（V1 简化：剥 *. 后按后缀）
        const stripped = v.replace(/^\*\./, '').replace(/\*/g, '');
        if (stripped) set.suffixes.add(stripped);
      } else if (/^keyword:/.test(v)) {
        set.keywords.add(v.slice(9));
      } else {
        set.suffixes.add(v);
        set.exact.add(v);
      }
    }
    return { domains: set };
  }
  if (behavior === 'ipcidr') {
    const cidrs: CidrRule[] = [];
    for (const e of entries) {
      const v = e.trim();
      if (!v || v.startsWith('#')) continue;
      const c = parseCidr(v);
      if (c) cidrs.push(c);
    }
    return { cidrs };
  }
  // classical：'DOMAIN-SUFFIX,openai.com' / 'IP-CIDR,1.2.3.4/32,no-resolve' 等
  const classical = [];
  for (const e of entries) {
    const v = e.trim();
    if (!v || v.startsWith('#')) continue;
    try {
      // 条目自带可选 target（末段）；target 统一换成 PLACEHOLDER（匹配时被 RULE-SET 行覆盖）
      const parts = v.split(',').map((s) => s.trim());
      const type = parts[0];
      if (type === 'MATCH') {
        classical.push(parseRuleLine('MATCH,PLACEHOLDER'));
        continue;
      }
      const payload = parts[1];
      const noResolve = parts[parts.length - 1] === 'no-resolve' && parts.length >= 3;
      if (!payload) continue;
      const reconstructed = `${type},${payload},PLACEHOLDER${noResolve ? ',no-resolve' : ''}`;
      classical.push(parseRuleLine(reconstructed));
    } catch (_e) {
      // 忽略坏行
    }
  }
  return { classical };
}

function extractEntries(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('payload:')) {
    const v = parseYaml(text);
    const m = asMap(v, 'payload root');
    const list = m['payload'];
    if (list === undefined || list === null) return [];
    return asSeq(list as YamlValue, 'payload').map((x) => asStr(x, 'payload[]'));
  }
  return text.split('\n');
}
