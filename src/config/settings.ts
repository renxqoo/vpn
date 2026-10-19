import { logger } from '../core/log.ts';
import { DEFAULT_CONFIG_YAML } from './defaults.ts';
import { parseClashConfig, type ClashConfig, type ProxyGroupConfig } from './clash.ts';
import { DOTENV_PATH, HOME_CONFIG_PATH, ensureHomeConfig, parseDotEnv } from './paths.ts';

const log = logger('config:settings');

export interface FileInputs {
  homeConfigText: string;
  dotenvText: string | null;
}

export interface RuntimeSettings {
  subscriptionUrl?: string;
  selectedNode?: string;
  secret?: string;
  mode: 'rule' | 'global' | 'direct';
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  httpPort?: number;
  socksPort?: number;
  mixedPort?: number;
  apiPort?: number;
  source: 'dotenv' | 'home' | 'empty';
}

const SELECTED_NODE_RE = /^selected-node:\s*(?:'((?:[^']|'')*)'|([^\n]+?))\s*$/m;
const MODE_RE = /^mode:\s*(\S+)/m;
const LOG_LEVEL_RE = /^log-level:\s*(\S+)/m;
const PORT_RE = /^port:\s*(\d+)\s*$/m;
const SOCKS_PORT_RE = /^socks-port:\s*(\d+)\s*$/m;
const MIXED_PORT_RE = /^mixed-port:\s*(\d+)\s*$/m;
const SUB_URL_RE = /^subscription-url:[ \t]*(?:'((?:[^'\n]|'')*)'|([^\n]*?))[ \t]*$/m;

function firstGroup(m: RegExpMatchArray | null): string | undefined {
  if (!m) return undefined;
  return (m[1] ?? m[2])?.trim() || undefined;
}

/** 家目录配置文本 → 键集（settings 语义，与 Clash YAML 体的解析解耦） */
export function parseHomeKeys(text: string): RuntimeSettings {
  const subMatch = SUB_URL_RE.exec(text);
  const sub = (subMatch?.[1]?.replace(/''/g, "'") ?? subMatch?.[2])?.trim() || undefined;
  const selMatch = SELECTED_NODE_RE.exec(text);
  const selectedNode = selMatch ? (selMatch[1]?.replace(/''/g, "'") ?? selMatch[2]?.trim()) || undefined : undefined;
  const modeRaw = firstGroup(MODE_RE.exec(text));
  const mode = modeRaw === 'global' || modeRaw === 'direct' ? modeRaw : 'rule';
  const logRaw = firstGroup(LOG_LEVEL_RE.exec(text));
  const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);
  const logLevel = logRaw !== undefined && LOG_LEVELS.has(logRaw) ? logRaw : undefined;
  const port = Number(firstGroup(PORT_RE.exec(text)));
  const socks = Number(firstGroup(SOCKS_PORT_RE.exec(text)));
  const mixed = Number(firstGroup(MIXED_PORT_RE.exec(text)));
  const secretMatch = /^secret:\s*(?:'([^'\n]*)'|"([^"\n]*)"|([^\n]*?))\s*$/m.exec(text);
  const secret = (secretMatch?.[1] ?? secretMatch?.[2] ?? secretMatch?.[3] ?? '').trim();
  return {
    subscriptionUrl: sub,
    selectedNode,
    mode,
    logLevel,
    secret,
    httpPort: Number.isInteger(port) && port > 0 ? port : undefined,
    socksPort: Number.isInteger(socks) && socks > 0 ? socks : undefined,
    mixedPort: Number.isInteger(mixed) && mixed > 0 ? mixed : undefined,
    apiPort: undefined,
    source: sub ? 'home' : 'empty',
  };
}

/** 两级来源合并：.env 管订阅与端口；家目录管订阅/节点/模式；.env 订阅优先 */
export function mergeSource(files: FileInputs): RuntimeSettings {
  const home = parseHomeKeys(files.homeConfigText);
  if (files.dotenvText === null) return home;
  const kv = parseDotEnv(files.dotenvText);
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const envUrlRaw = kv['SUBSCRIPTION_URL'] || undefined;
  const envUrl = envUrlRaw !== undefined && !/^https:\/\//.test(envUrlRaw)
    ? (() => {
        log.warn('.env SUBSCRIPTION_URL 非 https:// 已拒绝（明文订阅可被整体替换）');
        return undefined;
      })()
    : envUrlRaw;
  const subscriptionUrl = envUrl ?? home.subscriptionUrl;
  const source: RuntimeSettings['source'] = envUrl ? 'dotenv' : home.subscriptionUrl ? 'home' : 'empty';
  return {
    ...home,
    subscriptionUrl,
    httpPort: num(kv['PORT']) ?? home.httpPort,
    socksPort: num(kv['SOCKS_PORT']) ?? home.socksPort,
    mixedPort: num(kv['MIXED_PORT']) ?? home.mixedPort,
    apiPort: num(kv['API_PORT']) ?? home.apiPort,
    source,
  };
}

export interface BuildOptions {
  files: FileInputs;
  subscriptionYaml: string | null;
  cli?: { port?: number; socksPort?: number; apiPort?: number; mixedPort?: number; direct?: boolean };
}

export interface RuntimeConfig {
  config: ClashConfig;
  settings: RuntimeSettings;
  overrides: { httpPort: number; socksPort: number; apiPort: number; mixedPort?: number };
  sourceLabel: string;
  needsSubscriptionGuide: boolean;
  warnings: string[];
}

function parseApiPort(addr: string | null | undefined): number | undefined {
  if (!addr) return undefined;
  const m = /:(\d+)$/.exec(addr);
  return m ? Number(m[1]) : undefined;
}

const DIRECT_FALLBACK_RULES: ClashConfig['rules'] = [
  { type: 'MATCH', payload: '', target: 'DIRECT', noResolve: false, raw: 'MATCH,DIRECT' },
];

/** 合并 + 订阅解析 + CLI 覆盖 → App 需要的一切（App 不再读任何文件） */
export async function buildRuntimeConfig(opts: BuildOptions): Promise<RuntimeConfig> {
  const settings = mergeSource(opts.files);
  const warnings: string[] = [];
  const cli = opts.cli ?? {};
  const overrides = {
    httpPort: cli.port ?? settings.httpPort,
    socksPort: cli.socksPort ?? settings.socksPort,
    apiPort: cli.apiPort ?? settings.apiPort,
    mixedPort: cli.mixedPort ?? settings.mixedPort,
  };

  let config: ClashConfig;
  let needsGuide = false;
  if (opts.cli?.direct || !settings.subscriptionUrl) {
    if (!opts.cli?.direct) needsGuide = true;
    config = {
      httpPort: overrides.httpPort ?? 7890,
      socksPort: overrides.socksPort ?? 7891,
      mode: 'rule',
      logLevel: 'info',
      apiAddr: '127.0.0.1:9090',
      apiSecret: settings.secret ?? '',
      proxies: [],
      groups: [],
      rules: DIRECT_FALLBACK_RULES,
      ruleProviders: new Map(),
    };
  } else {
    if (opts.subscriptionYaml === null) {
      // 订阅存在但内容不可得（拉取失败）：settings 层无法兜底——start 层负责失败语义
      throw new Error('subscription yaml required');
    }
    config = parseClashConfig(opts.subscriptionYaml);
  }

  const finalConfig: ClashConfig = {
    ...config,
    httpPort: overrides.httpPort ?? config.httpPort,
    socksPort: overrides.socksPort ?? config.socksPort,
    mode: settings.mode,
    logLevel: settings.logLevel ?? 'info',
    apiSecret: settings.secret !== undefined && settings.secret !== '' ? settings.secret : config.apiSecret,
  };

  if (settings.selectedNode) {
    const group = finalConfig.groups.find((g) => g.name === '🚀 节点选择');
    const wanted = settings.selectedNode;
    if (group && group.type === 'select' && group.proxies.includes(wanted) &&
      finalConfig.proxies.some((p) => p.kind === 'anytls' && p.name === wanted)) {
      reorderGroupFirst(group, wanted);
    } else if (group) {
      const msg = `selected-node '${settings.selectedNode}' 不在节点选择组内，已忽略`;
      warnings.push(msg);
      log.warn(msg);
      settings.selectedNode = undefined;
    } else {
      warnings.push(`订阅无可用的 '🚀 节点选择' 组，selected-node 未生效`);
      settings.selectedNode = undefined;
    }
  }

  const parts: string[] = [];
  if (settings.source === 'dotenv') parts.push('.env（订阅）');
  else if (settings.source === 'home') parts.push('~/.vpn/config.yaml（订阅）');
  if (opts.files.dotenvText !== null && settings.source !== 'dotenv') parts.push('.env（端口覆盖）');
  const sourceLabel = parts.length > 0 ? parts.join(' + ') : '空（直连）';

  const effectiveApiPort = overrides.apiPort ?? parseApiPort(config.apiAddr) ?? 9090;

  return {
    config: finalConfig,
    settings: { ...settings },
    overrides: {
      httpPort: finalConfig.httpPort,
      socksPort: finalConfig.socksPort,
      apiPort: effectiveApiPort,
      mixedPort: overrides.mixedPort,
    },
    sourceLabel,
    needsSubscriptionGuide: needsGuide,
    warnings,
  };
}

function reorderGroupFirst(group: ProxyGroupConfig, nodeName: string): void {
  const idx = group.proxies.indexOf(nodeName);
  if (idx > 0) {
    group.proxies.splice(idx, 1);
    group.proxies.unshift(nodeName);
  }
}

void DEFAULT_CONFIG_YAML;

async function readFileIfExists(path: string): Promise<string | null> {
  const f = Bun.file(path);
  return (await f.exists()) ? f.text() : null;
}

/** 读取两级配置文件的原始文本（家目录配置不存在则先生成） */
export async function collectFileInputs(): Promise<FileInputs> {
  await ensureHomeConfig();
  const homeConfigText = await readFileIfExists(HOME_CONFIG_PATH());
  const dotenvText = await readFileIfExists(DOTENV_PATH());
  return { homeConfigText: homeConfigText ?? '', dotenvText };
}
