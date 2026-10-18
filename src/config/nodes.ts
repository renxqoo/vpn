/**
 * 交互式节点选择（design.md §1.1）：`bun run nodes`
 * - @clack/prompts 列表（地区分组）
 * - 选中后写 ~/.vpn/config.yaml 的 selected-node 键
 * - 内核在运行（API 可达）时同时热切换，免重启
 */

import * as p from '@clack/prompts';
import { collectFileInputs, mergeSource } from './settings.ts';
import { parseClashConfig } from '../config/clash.ts';
import { HOME_CONFIG_PATH, cacheDirectory } from './paths.ts';
import { defaultStore, loadSubscription } from '../config/subscription.ts';
import type { AnytlsProxyConfig, ProxyConfig } from '../config/clash.ts';

const GROUP_LABEL = '🚀 节点选择';

export interface NodeEntry {
  name: string;
  region: string;
  server: string;
}

/** 节点名 → 地区（「台湾 01」「美国 06 (家宽)」→ 台湾/美国） */
export function regionOf(name: string): string {
  const m = /^([^\s0-9]+)/.exec(name.trim());
  return m?.[1] ?? '其他';
}

export function listSelectableNodes(proxies: ProxyConfig[]): NodeEntry[] {
  return proxies
    .filter((x): x is AnytlsProxyConfig => x.kind === 'anytls')
    .map((x) => ({ name: x.name, region: regionOf(x.name), server: x.server }));
}

/** 按 clack optgroup 期望的结构分组 */
export function groupByRegion(nodes: NodeEntry[]): Map<string, NodeEntry[]> {
  const groups = new Map<string, NodeEntry[]>();
  for (const n of nodes) {
    const list = groups.get(n.region) ?? [];
    list.push(n);
    groups.set(n.region, list);
  }
  return groups;
}

/** 写 selected-node 到家目录配置（保留其余行；value 为空则移除该键） */
export async function writeSelectedNode(nodeName: string | null): Promise<string> {
  const path = HOME_CONFIG_PATH();
  const f = Bun.file(path);
  let text = (await f.exists()) ? await f.text() : '';
  if (nodeName === null) {
    text = text.replace(/^selected-node:.*$\n?/m, '');
  } else if (/^selected-node:.*$/m.test(text)) {
    text = text.replace(/^selected-node:.*$/m, `selected-node: '${nodeName.replace(/'/g, "''")}'`);
  } else {
    text = `selected-node: '${nodeName.replace(/'/g, "''")}'\n${text}`;
  }
  await Bun.write(path, text, { createPath: true });
  return path;
}

export async function readSelectedNode(): Promise<string | null> {
  const f = Bun.file(HOME_CONFIG_PATH());
  if (!(await f.exists())) return null;
  const text = await f.text();
  // 单引号风格：值内 '' 转义；也兼容无引号裸值
  const quoted = /^selected-node:\s*'((?:[^']|'')*)'\s*$/m.exec(text);
  if (quoted) return (quoted[1] as string).replace(/''/g, "'").trim();
  const bare = /^selected-node:\s*([^\n]+?)\s*$/m.exec(text);
  return bare?.[1]?.trim() ?? null;
}

/** 热切换（内核运行时）：返回 'switched' | 'not-running' | 'failed' */
export async function hotSwitch(apiPort: number, nodeName: string): Promise<'switched' | 'not-running' | 'failed'> {
  let alive = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${apiPort}/version`, { signal: AbortSignal.timeout(1500) });
    alive = probe.ok;
  } catch (_e) {
    return 'not-running';
  }
  if (!alive) return 'not-running';
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/proxies/${encodeURIComponent(GROUP_LABEL)}`, {
      method: 'PUT',
      body: JSON.stringify({ now: nodeName }),
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 204 ? 'switched' : 'failed';
  } catch (_e) {
    return 'failed';
  }
}

export async function runNodesCommand(
  apiPortArg?: number,
  directPick?: string,
): Promise<void> {
  const src = mergeSource(await collectFileInputs());
  if (!src.subscriptionUrl) {
    p.intro('bun-clash 节点选择');
    p.cancel('未配置订阅地址（.env 或 bun run config set-subscription）');
    process.exit(1);
  }
  const text = await loadSubscription(src.subscriptionUrl, defaultStore(cacheDirectory()));
  const cfg = parseClashConfig(text);
  const nodes = listSelectableNodes(cfg.proxies);
  if (nodes.length === 0) {
    p.intro('bun-clash 节点选择');
    p.cancel('订阅中没有可用的 anytls 节点');
    process.exit(1);
  }
  const groups = groupByRegion(nodes);
  const current = await readSelectedNode();
  if (directPick !== undefined) {
    const apiPort = apiPortArg ?? 9090;
    await applyPick(directPick, apiPort, nodes);
    return;
  }
  const apiPort = apiPortArg ?? 9090;
  const healthByNode = await fetchNodeHealth(apiPort);

  p.intro('bun-clash 节点选择');
  type Opt = { value: { group: boolean; label: string }; label: string; hint?: string };
  const options: Opt[] = [];
  for (const [region, list] of groups.entries()) {
    options.push({ value: { group: true, label: region }, label: `— ${region} —`, hint: `${list.length} 个节点` });
    for (const n of list) {
      const h = healthByNode[n.name];
      const hint = h
        ? h.alive
          ? `${h.delay}ms · ${n.server}`
          : `不可用 · ${n.server}`
        : n.server;
      options.push({ value: { group: false, label: n.name }, label: n.name, hint });
    }
  }
  const currentEntry = current ? nodes.find((n) => n.name === current) : undefined;
  const selected = await p.select({
    message: `选择节点${current ? `（当前: ${current}）` : ''}`,
    options,
    initialValue: currentEntry
      ? { group: false, label: currentEntry.name }
      : undefined,
  });

  if (p.isCancel(selected) || (selected as { group: boolean }).group) {
    p.cancel('未选择（交互取消或当前环境不支持交互式选择——终端运行，或用 --node <节点名>）');
    process.exit(1);
  }
  const nodeName = (selected as { label: string }).label;
  await applyPick(nodeName, apiPort);
}

/** 选中后共享路径：校验存在 → 落库 → 热切换 → 结果输出 */
async function applyPick(nodeName: string, apiPort: number, nodes?: NodeEntry[]): Promise<void> {
  if (nodes && !nodes.some((n) => n.name === nodeName)) {
    p.cancel(`节点不存在: ${nodeName}（可用节点见 bun-clash nodes 交互列表）`);
    process.exit(1);
  }
  const path = await writeSelectedNode(nodeName);
  const hot = await hotSwitch(apiPort, nodeName);
  const note =
    hot === 'switched'
      ? `已写入 ${path} 并热切换生效（无需重启）`
      : hot === 'not-running'
        ? `已写入 ${path}（内核未运行，下次启动生效）`
        : `已写入 ${path}，但热切换失败（内核运行中但切换未成功，重启后生效）`;
  p.outro(`✓ 节点: ${nodeName}\n${note}`);
}

async function fetchNodeHealth(apiPort: number): Promise<Record<string, { alive: boolean; delay: number | null }>> {
  const out: Record<string, { alive: boolean; delay: number | null }> = {};
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/proxies`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      proxies: Record<string, { health?: { alive: boolean; delay: number | null } | null }>;
    };
    for (const [name, info] of Object.entries(data.proxies)) {
      if (info.health) out[name] = { alive: info.health.alive, delay: info.health.delay };
    }
  } catch (_e) {
    /* 内核未运行——列表无延迟列 */
  }
  return out;
}
