/**
 * `bun-clash status`：运行状态总览（design.md §1.1 第四批）。
 * 数据拼合：配置文件（来源/订阅/选中节点）+ 运行内核 API（模式/当前出口/连接/延迟）。
 * 内核未运行时展示配置态并标注。
 */

import * as p from '@clack/prompts';
import { collectFileInputs, mergeSource } from './settings.ts';
import { readSelectedNode } from './nodes.ts';
import { readMode } from './mode.ts';
import { resolveController, readRunningController } from './controller.ts';
import { KERNEL_LOG_PATH } from './paths.ts';
import { formatNodeHealth, healthFromProxies, nodeHealthLines, type NodeHealthMap } from './node-health.ts';

export interface ApiState {
  mode: 'rule' | 'global' | 'direct';
  groupNow: string | null;
  delay: number | null;
  connections: number;
  upload: number;
  download: number;
  upRate: number;
  downRate: number;
  rules: number;
  proxies: number;
  nodeHealth: NodeHealthMap;
}

async function probeApi(apiPort: number, secret: string): Promise<ApiState | null> {
  const base = `http://127.0.0.1:${apiPort}`;
  const headers = secret ? { authorization: `Bearer ${secret}` } : undefined;
  const get = (path: string) => fetch(base + path, { headers, signal: AbortSignal.timeout(1500) });
  try {
    const [versionRes, proxiesRes, connsRes, rulesRes] = await Promise.all([
      get('/version'), get('/proxies'), get('/connections'), get('/rules'),
    ]);
    if (![versionRes, proxiesRes, connsRes, rulesRes].every((response) => response.ok)) return null;
    const proxies = (await proxiesRes.json()) as {
      proxies: Record<string, { type: string; now?: string; history?: Record<string, number>[]; health?: unknown }>;
    };
    const conns = (await connsRes.json()) as {
      totals?: { upload: number; download: number };
      connections: { upload: number; download: number; upRate: number; downRate: number }[];
    };
    const rules = (await rulesRes.json()) as { rules: unknown[] };
    const configsRes = await get('/configs');
    const configs = (await configsRes.json()) as { mode: ApiState['mode'] };

    const group = proxies.proxies['🚀 节点选择'] as { type: string; now?: string } | undefined;
    let delay: number | null = null;
    let groupNow: string | null = group?.now ?? null;
    if (groupNow) {
      // 当前出口的最近延迟（组的 history 里取）
      const hist = (group as { history?: Record<string, number | null> }).history;
      if (hist && typeof hist[groupNow] === 'number') delay = hist[groupNow];
    }
    // 组成员的延迟视图在 /proxies/<node> 的 history；组上若无，试当前节点详情
    if (delay === null && groupNow) {
      const nodeRes = await get(`/proxies/${encodeURIComponent(groupNow)}`);
      if (nodeRes.ok) {
        const node = (await nodeRes.json()) as { history?: Record<string, number | null> };
        const h = node.history;
        if (h && typeof h[groupNow] === 'number') delay = h[groupNow];
        else {
          const first = Object.values(h ?? {}).find((v): v is number => typeof v === 'number' && v >= 0);
          delay = first ?? null;
        }
      }
    }
    const nodeHealth = healthFromProxies(proxies.proxies);
    if (groupNow && nodeHealth[groupNow]?.samples) delay = nodeHealth[groupNow]!.delay;
    return {
      mode: configs.mode,
      groupNow,
      delay,
      connections: conns.connections.length,
      upload: conns.totals?.upload ?? conns.connections.reduce((n, c) => n + c.upload, 0),
      download: conns.totals?.download ?? conns.connections.reduce((n, c) => n + c.download, 0),
      upRate: conns.connections.reduce((n, c) => n + c.upRate, 0),
      downRate: conns.connections.reduce((n, c) => n + c.downRate, 0),
      rules: rules.rules.length,
      proxies: Object.keys(nodeHealth).length,
      nodeHealth,
    };
  } catch (_e) {
    return null;
  }
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

const MODE_CN: Record<ApiState['mode'], string> = { rule: '规则', global: '全局', direct: '直连' };

export async function runStatusCommand(apiPortArg?: number): Promise<void> {
  const src = mergeSource(await collectFileInputs());
  const selected = await readSelectedNode();
  const modeInConfig = await readMode();
  const { apiPort, secret } = await resolveController(src.apiPort ?? 9090, src.secret ?? '', apiPortArg);
  const running = await readRunningController();
  const api = await probeApi(apiPort, secret);

  p.intro('bun-clash 状态');

  // 运行状态行
  if (api) {
    const how = running?.daemon ? '后台守护' : '前台';
    p.log.success(`内核运行中（${how}，PID ${running?.pid ?? '?'}，API 127.0.0.1:${apiPort}）`);
    if (running?.daemon) p.log.message(`  日志路径  ${KERNEL_LOG_PATH()}`);
  } else {
    p.log.warn(`内核未运行（API 127.0.0.1:${apiPort} 不可达）——以下为配置态`);
  }

  // 配置段
  const sourceLabel =
    src.source === 'dotenv' ? '.env（dev）' : src.source === 'home' ? '~/.vpn/config.yaml' : '未配置';
  const rows: [string, string][] = [
    ['配置来源', sourceLabel],
    ['订阅地址', src.subscriptionUrl ? maskUrl(src.subscriptionUrl) : '（空）'],
    ['代理模式', api ? `${MODE_CN[api.mode]}（运行时）` : `${MODE_CN[modeInConfig]}（配置）`],
    ['选中节点', selected ?? '（未选择——bun-clash nodes）'],
  ];
  if (api) {
    rows.push(['当前出口', api.groupNow ?? '（无）']);
    const currentHealth = api.groupNow ? api.nodeHealth[api.groupNow] : undefined;
    rows.push(['节点状态', currentHealth ? formatNodeHealth(currentHealth) :
      api.delay !== null ? `可用 · ${api.delay}ms` : '未探测']);
  }
  if (src.mixedPort) {
    rows.push(['混合端口', String(src.mixedPort)]);
  } else {
    rows.push(['HTTP 端口', String(src.httpPort ?? 7890)]);
    rows.push(['SOCKS 端口', String(src.socksPort ?? 7891)]);
  }
  rows.push(['API 端口', String(apiPort)]);
  for (const [k, v] of rows) {
    p.log.message(`  ${k.padEnd(6, '　')} ${v}`);
  }

  // 运行统计段
  if (api) {
    p.log.message(
      `  实时网速  ↑${fmtBytes(api.upRate)}/s ↓${fmtBytes(api.downRate)}/s`,
    );
    p.log.message(
      `  会话流量  ${api.connections} 活跃连接 · 累计 ↑${fmtBytes(api.upload)} ↓${fmtBytes(api.download)}`,
    );
    p.log.message(`  规则数  ${api.rules} · 节点 ${api.proxies} 个`);
  }

  if (api && Object.keys(api.nodeHealth).length > 0) {
    p.log.message('  全部节点（最近探测；nodes --check 可刷新）');
    for (const line of nodeHealthLines(Object.keys(api.nodeHealth), api.nodeHealth)) p.log.message(`    ${line}`);
  }

  p.outro(api ? '提示：bun-clash nodes / mode 可切换；usage 看流量' : '提示：bun-clash start 启动内核');
}

function maskUrl(url: string): string {
  // 展示层脱敏：保留 host 与路径前 6 字符，token 打码
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    const token = seg[seg.length - 1] ?? '';
    if (token.length > 8) {
      seg[seg.length - 1] = `${token.slice(0, 4)}****${token.slice(-4)}`;
    }
    return `${u.host}/${seg.join('/')}${u.search}`;
  } catch (_e) {
    return url;
  }
}
