/**
 * Clash 配置模型与解析（design.md §1.5）：订阅 YAML → 内部配置。
 * 未知节点 type 标记 unavailable；未知顶层键警告；dns/sniffer/tun 忽略警告。
 */

import { logger } from '../core/log.ts';
import { asBool, asMap, asNum, asSeq, asStr, optBool, optNum, optStr, parseYaml, type YamlValue } from './yaml.ts';

const log = logger('config:clash');

export interface AnytlsProxyConfig {
  kind: 'anytls';
  name: string;
  server: string;
  port: number;
  password: string;
  sni?: string;
  skipCertVerify: boolean;
  udp: boolean;
  idleSessionCheckIntervalSec: number;
  idleSessionTimeoutSec: number;
  minIdleSession: number;
}

export interface UnknownProxyConfig {
  kind: 'unknown';
  name: string;
  type: string;
}

export type ProxyConfig = AnytlsProxyConfig | UnknownProxyConfig;

export type GroupType = 'select' | 'url-test' | 'fallback';

export interface ProxyGroupConfig {
  name: string;
  type: GroupType;
  proxies: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
}

export type RuleType =
  | 'DOMAIN'
  | 'DOMAIN-SUFFIX'
  | 'DOMAIN-KEYWORD'
  | 'IP-CIDR'
  | 'IP-CIDR6'
  | 'GEOIP'
  | 'RULE-SET'
  | 'MATCH';

export interface RuleConfig {
  type: RuleType;
  payload: string; // MATCH 为空
  target: string;
  noResolve: boolean;
  raw: string;
}

export interface RuleProviderConfig {
  name: string;
  behavior: 'domain' | 'ipcidr' | 'classical';
  format: 'yaml' | 'text';
  url?: string;
  path?: string;
  interval: number;
}

export interface ClashConfig {
  httpPort: number;
  socksPort: number;
  mode: 'rule' | 'global' | 'direct';
  logLevel: string;
  apiAddr: string | null;
  apiSecret: string;
  proxies: ProxyConfig[];
  groups: ProxyGroupConfig[];
  rules: RuleConfig[];
  ruleProviders: Map<string, RuleProviderConfig>;
  geoipUrl?: string;
}

export class ConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ConfigError';
  }
}

const KNOWN_TOP_KEYS = new Set([
  'port', 'socks-port', 'mixed-port', 'redir-port', 'allow-lan', 'ipv6', 'mode',
  'log-level', 'external-controller', 'secret', 'proxies', 'proxy-groups', 'rules',
  'rule-providers', 'dns', 'sniffer', 'tun', 'geox-url', 'tcp-concurrent',
  'unified-delay', 'global-client-fingerprint', 'geodata-mode', 'geo-auto-update',
  'geo-update-interval', 'profile', 'hosts',
]);

const IGNORED_KEYS = new Set([
  'dns', 'sniffer', 'tun', 'geodata-mode', 'geo-auto-update', 'geo-update-interval', 'hosts',
  'profile', 'tcp-concurrent', 'unified-delay', 'global-client-fingerprint', 'allow-lan', 'ipv6',
]);

export function parseClashConfig(text: string): ClashConfig {
  const root = parseYaml(text);
  const m = asMap(root, 'root');
  for (const key of Object.keys(m)) {
    if (!KNOWN_TOP_KEYS.has(key)) log.warn(`unknown top-level key '${key}' ignored`);
    else if (IGNORED_KEYS.has(key)) log.warn(`key '${key}' present but not supported in V1 (ignored)`);
  }

  const httpPort = optNum(m['port']) ?? optNum(m['mixed-port']) ?? 7890;
  const socksPort = optNum(m['socks-port']) ?? 7891;
  const modeRaw = optStr(m['mode']) ?? 'rule';
  if (modeRaw !== 'rule' && modeRaw !== 'global' && modeRaw !== 'direct') {
    throw new ConfigError(`invalid mode '${modeRaw}'`);
  }
  const logLevel = optStr(m['log-level']) ?? 'info';
  const apiAddr = optStr(m['external-controller']) ?? null;
  const apiSecret = optStr(m['secret']) ?? '';

  // proxies
  const proxies: ProxyConfig[] = [];
  if (m['proxies'] !== undefined && m['proxies'] !== null) {
    for (const item of asSeq(m['proxies'], 'proxies')) {
      const p = asMap(item, 'proxies[]');
      const name = asStr(p['name'] as YamlValue, 'proxies.name');
      const type = asStr(p['type'] as YamlValue, 'proxies.type');
      if (type === 'anytls') {
        proxies.push({
          kind: 'anytls',
          name,
          server: asStr(p['server'] as YamlValue, 'proxies.server'),
          port: asNum(p['port'] as YamlValue, 'proxies.port'),
          password: asStr(p['password'] as YamlValue, 'proxies.password'),
          sni: optStr(p['sni']),
          skipCertVerify: optBool(p['skip-cert-verify']) ?? false,
          udp: optBool(p['udp']) ?? false,
          idleSessionCheckIntervalSec: optNum(p['idle-session-check-interval']) ?? 30,
          idleSessionTimeoutSec: optNum(p['idle-session-timeout']) ?? 30,
          minIdleSession: optNum(p['min-idle-session']) ?? 5,
        });
      } else {
        log.warn(`proxy '${name}': type '${type}' not supported in V1 (marked unavailable)`);
        proxies.push({ kind: 'unknown', name, type });
      }
    }
  }

  // groups
  const groups: ProxyGroupConfig[] = [];
  if (m['proxy-groups'] !== undefined && m['proxy-groups'] !== null) {
    for (const item of asSeq(m['proxy-groups'], 'proxy-groups')) {
      const g = asMap(item, 'proxy-groups[]');
      const name = asStr(g['name'] as YamlValue, 'group.name');
      const typeRaw = asStr(g['type'] as YamlValue, 'group.type');
      if (typeRaw !== 'select' && typeRaw !== 'url-test' && typeRaw !== 'fallback') {
        log.warn(`group '${name}': type '${typeRaw}' unsupported (ignored)`);
        continue;
      }
      groups.push({
        name,
        type: typeRaw,
        proxies: asSeq(g['proxies'] as YamlValue, 'group.proxies').map((x) => asStr(x, 'group.proxies[]')),
        url: optStr(g['url']),
        interval: optNum(g['interval']),
        tolerance: optNum(g['tolerance']),
      });
    }
  }

  // rules
  const rules: RuleConfig[] = [];
  if (m['rules'] !== undefined && m['rules'] !== null) {
    for (const item of asSeq(m['rules'], 'rules')) {
      const raw = asStr(item, 'rules[]');
      const parsed = parseRuleLine(raw);
      rules.push(parsed);
    }
  }

  // rule-providers
  const ruleProviders = new Map<string, RuleProviderConfig>();
  if (m['rule-providers'] !== undefined && m['rule-providers'] !== null) {
    const rpm = asMap(m['rule-providers'], 'rule-providers');
    for (const [name, v] of Object.entries(rpm)) {
      const p = asMap(v, `rule-providers.${name}`);
      const behaviorRaw = optStr(p['behavior']) ?? 'domain';
      if (behaviorRaw !== 'domain' && behaviorRaw !== 'ipcidr' && behaviorRaw !== 'classical') {
        throw new ConfigError(`rule-provider '${name}': invalid behavior '${behaviorRaw}'`);
      }
      const formatRaw = optStr(p['format']);
      ruleProviders.set(name, {
        name,
        behavior: behaviorRaw,
        format: formatRaw === 'text' ? 'text' : 'yaml',
        url: optStr(p['url']),
        path: optStr(p['path']),
        interval: Math.max(optNum(p['interval']) ?? 86400, 60),
      });
    }
  }

  // 引用完整性：rules 的目标（组/节点）、组的成员存在性
  const names = new Set<string>([...proxies.map((p) => p.name), ...groups.map((g) => g.name), 'DIRECT', 'REJECT']);
  for (const r of rules) {
    if (!names.has(r.target)) {
      throw new ConfigError(`rule '${r.raw}' references unknown target '${r.target}'`);
    }
  }
  for (const g of groups) {
    for (const member of g.proxies) {
      if (!names.has(member)) {
        throw new ConfigError(`group '${g.name}' references unknown member '${member}'`);
      }
    }
  }

  // geox-url
  let geoipUrl: string | undefined;
  if (m['geox-url'] !== undefined && m['geox-url'] !== null) {
    const gx = asMap(m['geox-url'], 'geox-url');
    geoipUrl = optStr(gx['mmdb']) ?? optStr(gx['geoip']);
  }

  const mode: ClashConfig['mode'] = modeRaw;
  return {
    httpPort,
    socksPort,
    mode,
    logLevel,
    apiAddr,
    apiSecret,
    proxies,
    groups,
    rules,
    ruleProviders,
    geoipUrl,
  };
}

const RULE_TYPES: RuleType[] = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'IP-CIDR', 'IP-CIDR6', 'GEOIP', 'RULE-SET', 'MATCH',
];

export function parseRuleLine(raw: string): RuleConfig {
  const parts = raw.split(',').map((s) => s.trim());
  const type = parts[0];
  if (type === 'MATCH') {
    const target = parts[1];
    if (!target) throw new ConfigError(`rule '${raw}': MATCH needs a target`);
    return { type: 'MATCH', payload: '', target, noResolve: false, raw };
  }
  if (!RULE_TYPES.includes(type as RuleType)) {
    throw new ConfigError(`rule '${raw}': unknown type '${type}'`);
  }
  const payload = parts[1];
  const target = parts[2];
  const last = parts[parts.length - 1];
  const noResolve = last === 'no-resolve' && parts.length >= 4;
  if (!payload || !target) {
    throw new ConfigError(`rule '${raw}': missing payload or target`);
  }
  return { type: type as RuleType, payload, target, noResolve, raw };
}

/** 内置私网段（GEOIP LAN 用；design.md rules.test GEOIP(LAN)） */
export const LAN_CIDRS = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16',
  '100.64.0.0/10', '224.0.0.0/4', '0.0.0.0/8', 'fc00::/7', 'fe80::/10', '::1/128',
];

void asBool;
