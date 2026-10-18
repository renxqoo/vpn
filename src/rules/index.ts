/**
 * 规则引擎（design.md §1.5/§2）：规则链匹配 + RULE-SET 引用 + no-resolve。
 * domain 集合：Map<label, Set<suffix>> 支持多层后缀；ipcidr：CIDR 数组线性扫描（V1 量级可接受）。
 */

import { isIpv4 } from '../core/socksaddr.ts';
import type { RouteContext, RouteDecision, Router } from '../core/types.ts';
import { LAN_CIDRS, type RuleConfig } from '../config/clash.ts';

export interface DomainSet {
  /** 精确与后缀（'+.a.com' 存 a.com 与 a.com 的所有子域） */
  suffixes: Set<string>;
  exact: Set<string>;
  keywords: Set<string>;
}

export interface CidrRule {
  prefix: bigint;
  /** 有效位（v4 时 96+bits） */
  bits: number;
  v6: boolean;
  v4bits: number;
  target?: string;
}

export interface ResolvedRuleSet {
  domains?: DomainSet;
  cidrs?: CidrRule[];
  /** classical: 逐条原始规则（复用 RuleConfig 匹配，target 由 RULE-SET 行给出） */
  classical?: RuleConfig[];
}

export interface RuleEngineOptions {
  rules: RuleConfig[];
  providers: Map<string, RuleProviderRuntime>;
  geoip: GeoipLookup | null;
  /** 兜底（无 MATCH 时） */
  final: string;
}

export interface RuleProviderRuntime {
  resolved: ResolvedRuleSet;
}

export type GeoipLookup = (ip: string) => string | null;

export class RuleEngine implements Router {
  private rules: RuleConfig[];
  private providers: Map<string, RuleProviderRuntime>;
  private geoip: GeoipLookup | null;
  private final: string;

  constructor(opts: RuleEngineOptions) {
    this.rules = opts.rules;
    this.providers = opts.providers;
    this.geoip = opts.geoip;
    this.final = opts.final;
  }

  resolve(ctx: RouteContext): RouteDecision {
    for (const rule of this.rules) {
      const hit = this.match(rule, ctx);
      if (hit !== null) return hit;
    }
    return { outbound: this.final };
  }

  private match(rule: RuleConfig, ctx: RouteContext): RouteDecision | null {
    const host = ctx.host.replace(/\.$/, '').toLowerCase();
    switch (rule.type) {
      case 'DOMAIN':
        return host === rule.payload.toLowerCase() ? target(rule) : null;
      case 'DOMAIN-SUFFIX': {
        const suffix = rule.payload.toLowerCase().replace(/^\+\./, '');
        if (host === suffix || host.endsWith('.' + suffix)) return target(rule);
        return null;
      }
      case 'DOMAIN-KEYWORD':
        return host.includes(rule.payload.toLowerCase()) ? target(rule) : null;
      case 'IP-CIDR':
      case 'IP-CIDR6': {
        if (!ctx.isIp) {
          if (rule.noResolve) return null;
          return null; // IP 规则遇到域名：V1 无解析（design：no-resolve 或跳过）——统一跳过
        }
        if (matchCidr(host, rule.payload)) return target(rule);
        return null;
      }
      case 'GEOIP': {
        if (!ctx.isIp) return null;
        const code = rule.payload.toUpperCase();
        if (code === 'LAN') {
          return LAN_CIDRS.some((c) => matchCidr(host, c)) ? target(rule) : null;
        }
        if (!this.geoip) return null;
        const country = this.geoip(host);
        return country === code ? target(rule) : null;
      }
      case 'RULE-SET': {
        const prov = this.providers.get(rule.payload);
        if (!prov) return null;
        const rs = prov.resolved;
        if (rs.domains && !ctx.isIp) {
          if (matchDomainSet(rs.domains, host)) return target(rule);
        }
        if (rs.cidrs && ctx.isIp) {
          for (const c of rs.cidrs) {
            if (matchCidrBig(host, c)) return target(rule);
          }
        }
        if (rs.classical) {
          for (const sub of rs.classical) {
            const hit = this.match(sub, ctx);
            if (hit) return target(rule); // classical 条目只判命中，target 用 RULE-SET 行
          }
        }
        return null;
      }
      case 'MATCH':
        return target(rule);
    }
  }

  /** API：规则列表视图 */
  listRules(): { type: string; payload: string; target: string }[] {
    return this.rules.map((r) => ({ type: r.type, payload: r.payload, target: r.target }));
  }
}

function target(rule: RuleConfig): RouteDecision {
  if (rule.target === 'REJECT') return { reject: true };
  return { outbound: rule.target };
}

export function matchDomainSet(set: DomainSet, host: string): boolean {
  if (set.exact.has(host)) return true;
  if (set.keywords.size > 0) {
    for (const k of set.keywords) {
      if (host.includes(k)) return true;
    }
  }
  // 后缀：逐级剥标签
  const labels = host.split('.');
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (set.suffixes.has(suffix)) return true;
  }
  return false;
}

/** '10.0.0.0/8' 匹配 IPv4/IPv6 文本（v4 与 v6 各在自身空间比较） */
export function matchCidr(host: string, cidr: string): boolean {
  const c = parseCidr(cidr);
  if (!c) return false;
  return matchCidrBig(host, c);
}

export function parseCidr(cidr: string): CidrRule | null {
  const [rawAddr, rawBits] = cidr.split('/');
  if (!rawAddr || rawBits === undefined) return null;
  const bits = Number(rawBits);
  if (!Number.isInteger(bits) || bits < 0) return null;
  if (isIpv4(rawAddr)) {
    if (bits > 32) return null;
    // v4 用 32 位空间（shift 记 128-32-bits，即把 prefix 放高位对齐）
    return { prefix: ipv4ToBig(rawAddr) << 96n, bits: bits + 96, v6: false, v4bits: bits };
  }
  const v6 = ipv6ToBig(rawAddr);
  if (v6 === null) return null;
  if (bits > 128) return null;
  return { prefix: v6, bits, v6: true, v4bits: bits };
}

export function ipv4ToBig(ip: string): bigint {
  const parts = ip.split('.').map(Number);
  let v = 0n;
  for (const p of parts) {
    v = (v << 8n) | BigInt(p);
  }
  return v;
}

export function ipv6ToBig(ip: string): bigint | null {
  // 复用 core/socksaddr 的解析再转 bigint
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return null;
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function parseIpv6Bytes(s: string): Uint8Array | null {
  // 简化：通过 URL 解析规范 IPv6（含 ::）——文本已是 IP（isIp 判过）
  if (!s.includes(':')) return null;
  // 手写展开（与 socksaddr 相同逻辑，避免循环依赖直接复用实现）
  let head: bigint[] = [];
  let tail: bigint[] = [];
  let side: 'h' | 't' = 'h';
  const idx = s.indexOf('::');
  if (idx < 0) {
    const groups = s.split(':');
    if (groups.length !== 8) return null;
    for (const g of groups) {
      const v = parseInt(g || '0', 16);
      if (Number.isNaN(v)) return null;
      head.push(BigInt(v));
    }
  } else {
    if (s.indexOf('::', idx + 1) >= 0) return null;
    for (const g of s.slice(0, idx).split(':')) {
      if (!g) continue;
      const v = parseInt(g, 16);
      if (Number.isNaN(v)) return null;
      head.push(BigInt(v));
    }
    for (const g of s.slice(idx + 2).split(':')) {
      if (!g) continue;
      const v = parseInt(g, 16);
      if (Number.isNaN(v)) return null;
      tail.push(BigInt(v));
    }
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    head = [...head, ...new Array<bigint>(fill).fill(0n), ...tail];
  }
  const out = new Uint8Array(16);
  head.forEach((g, i) => {
    out[i * 2] = Number(g >> 8n);
    out[i * 2 + 1] = Number(g & 0xffn);
  });
  return out;
}

function matchCidrBig(host: string, rule: CidrRule): boolean {
  // v4 地址只在 v4 空间比较（v4-mapped 不与纯 v6 规则互通）
  const hostIsV4 = isIpv4(host);
  if (hostIsV4 && rule.v6) return false;
  if (!hostIsV4 && !rule.v6) return false;
  let ip: bigint;
  let shift: bigint;
  if (hostIsV4) {
    ip = ipv4ToBig(host) << 96n;
    shift = BigInt(128 - rule.v4bits); // 只比较 v4 前缀位（丢弃 96 映射零位 + 主机位）
  } else {
    const v = ipv6ToBig(host);
    if (v === null) return false;
    ip = v;
    shift = BigInt(128 - rule.bits);
  }
  return (ip >> shift) === (rule.prefix >> shift);
}
