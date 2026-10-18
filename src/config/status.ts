/**
 * `bun-clash status`：运行状态总览（design.md §1.1 第四批）。
 * 数据拼合：配置文件（来源/订阅/选中节点）+ 运行内核 API（模式/当前出口/连接/延迟）。
 * 内核未运行时展示配置态并标注。
 */

import * as p from '@clack/prompts';
import { resolveConfigSource } from './paths.ts';
import { readSelectedNode } from './nodes.ts';
import { readMode } from './mode.ts';

export interface ApiState {
  mode: 'rule' | 'global' | 'direct';
  groupNow: string | null;
  delay: number | null;
  connections: number;
  upload: number;
  download: number;
  rules: number;
  proxies: number;
}

async function probeApi(apiPort: number): Promise<ApiState | null> {
  const base = `http://127.0.0.1:${apiPort}`;
  try {
    const [versionRes, proxiesRes, connsRes, rulesRes] = await Promise.all([
      fetch(`${base}/version`, { signal: AbortSignal.timeout(1500) }),
      fetch(`${base}/proxies`, { signal: AbortSignal.timeout(1500) }),
      fetch(`${base}/connections`, { signal: AbortSignal.timeout(1500) }),
      fetch(`${base}/rules`, { signal: AbortSignal.timeout(1500) }),
    ]);
    if (!versionRes.ok) return null;
    const proxies = (await proxiesRes.json()) as {
      proxies: Record<string, { type: string; now?: string; history?: Record<string, number>[] }>;
    };
    const conns = (await connsRes.json()) as {
      connections: { upload: number; download: number }[];
    };
    const rules = (await rulesRes.json()) as { rules: unknown[] };
    const configsRes = await fetch(`${base}/configs`, { signal: AbortSignal.timeout(1500) });
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
      const nodeRes = await fetch(`${base}/proxies/${encodeURIComponent(groupNow)}`, {
        signal: AbortSignal.timeout(1500),
      });
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
    const groupTypes = new Set(['Selector', 'URLTest', 'URLFallback']);
    const anytlsCount = Object.values(proxies.proxies).filter((x) => !groupTypes.has(x.type)).length;
    return {
      mode: configs.mode,
      groupNow,
      delay,
      connections: conns.connections.length,
      upload: conns.connections.reduce((n, c) => n + c.upload, 0),
      download: conns.connections.reduce((n, c) => n + c.download, 0),
      rules: rules.rules.length,
      proxies: anytlsCount,
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
  const src = await resolveConfigSource();
  const selected = await readSelectedNode();
  const modeInConfig = await readMode();
  const apiPort = apiPortArg ?? 9090;
  const api = await probeApi(apiPort);

  p.intro('bun-clash 状态');

  // 运行状态行
  if (api) {
    p.log.success(`内核运行中（API 127.0.0.1:${apiPort}）`);
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
    rows.push(['节点延迟', api.delay !== null ? `${api.delay} ms` : '（未探测）']);
  }
  rows.push(['HTTP 端口', String(src.httpPort ?? 7890)]);
  rows.push(['SOCKS 端口', String(src.socksPort ?? 7891)]);
  rows.push(['API 端口', String(apiPort)]);
  for (const [k, v] of rows) {
    p.log.message(`  ${k.padEnd(6, '　')} ${v}`);
  }

  // 运行统计段
  if (api) {
    p.log.message(
      `  连接数  ${api.connections} 活跃 · ↑${fmtBytes(api.upload)} ↓${fmtBytes(api.download)}（当前连接累计）`,
    );
    p.log.message(`  规则数  ${api.rules} · 节点 ${api.proxies} 个`);
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
