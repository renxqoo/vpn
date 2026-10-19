/**
 * 交互式节点选择（design.md §1.1）：`bun run nodes`
 * - @clack/prompts 列表（地区分组）
 * - 选中后写 ~/.vpn/config.yaml 的 selected-node 键
 * - 内核在运行（API 可达）时同时热切换，免重启
 */

import * as p from '@clack/prompts';
import { buildRuntimeConfig, collectFileInputs, mergeSource } from './settings.ts';
import { HOME_CONFIG_PATH, cacheDirectory } from './paths.ts';
import { defaultStore, loadSubscription } from '../config/subscription.ts';
import { resolveController } from './controller.ts';
import { hotReload } from './reload.ts';
import type { AnytlsProxyConfig, ProxyConfig } from '../config/clash.ts';
import { checkNodeHealth, fetchNodeHealth, formatNodeHealth, nodeHealthLines } from './node-health.ts';
import type { NodeHealthMap } from './node-health.ts';

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
    text = text.replace(/^selected-node:.*$/m, () => `selected-node: '${nodeName.replace(/'/g, "''")}'`);
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
export async function hotSwitch(
  apiPort: number, nodeName: string, secret = '',
): Promise<'switched' | 'not-running' | 'failed'> {
  const headers = secret ? { authorization: `Bearer ${secret}` } : undefined;
  let alive = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${apiPort}/version`, { headers, signal: AbortSignal.timeout(1500) });
    alive = probe.ok;
  } catch (_e) {
    return 'not-running';
  }
  if (!alive) return 'failed';
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/proxies/${encodeURIComponent(GROUP_LABEL)}`, {
      method: 'PUT',
      headers,
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
  view: 'select' | 'list' | 'check' = 'select',
): Promise<void> {
  const files = await collectFileInputs();
  const src = mergeSource(files);
  if (!src.subscriptionUrl) {
    p.intro('bun-clash 节点选择');
    p.cancel('未配置订阅地址（.env 或 bun run config set-subscription）');
    process.exit(1);
  }
  const text = await loadSubscription(src.subscriptionUrl, defaultStore(cacheDirectory(), src.subscriptionUrl));
  const runtime = await buildRuntimeConfig({ files, subscriptionYaml: text });
  const cfg = runtime.config;
  if (view === 'select' && src.selectedNode && !runtime.settings.selectedNode) await writeSelectedNode(null);
  const nodes = listSelectableNodes(cfg.proxies);
  if (nodes.length === 0) {
    p.intro('bun-clash 节点选择');
    p.cancel('订阅中没有可用的 anytls 节点');
    process.exit(1);
  }
  const groups = groupByRegion(nodes);
  const current = runtime.settings.selectedNode;
  const { apiPort, secret } = await resolveController(
    runtime.overrides.apiPort, runtime.config.apiSecret, apiPortArg,
  );
  if (directPick !== undefined && view === 'select') {
    await applyPick(directPick, apiPort, nodes, secret);
    return;
  }
  const names = nodes.map((node) => node.name);
  if (view === 'check') {
    const targets = directPick === undefined ? names : names.filter((name) => name === directPick);
    if (targets.length === 0) throw new Error(`节点不存在: ${directPick}`);
    if (await fetchNodeHealth(apiPort, secret) === null) throw new Error('内核未运行，请先执行 bun-clash start');
    const progress = p.spinner();
    progress.start(`正在轻量探测 ${targets.length} 个节点（不切换当前节点）`);
    try {
      await checkNodeHealth(targets, apiPort, secret, (done, total) => progress.message(`已探测 ${done}/${total}`));
      progress.stop('节点探测完成');
    } catch (e) { progress.stop('节点探测未完成'); throw e; }
  }
  const health = await fetchNodeHealth(apiPort, secret);
  const healthByNode = health ?? (Object.create(null) as NodeHealthMap);

  if (view !== 'select') {
    p.intro('bun-clash 全部节点（最近探测）');
    for (const line of nodeHealthLines(names, healthByNode)) p.log.message(line);
    p.outro(health === null ? '内核未运行；状态显示为未探测' : '提示：nodes --check 刷新；nodes 可选择节点');
    return;
  }

  p.intro('bun-clash 节点选择');
  type Opt = { value: { group: boolean; label: string }; label: string; hint?: string };
  const options: Opt[] = [];
  for (const [region, list] of groups.entries()) {
    options.push({ value: { group: true, label: region }, label: `— ${region} —`, hint: `${list.length} 个节点` });
    for (const n of list) {
      const h = healthByNode[n.name];
      options.push({ value: { group: false, label: n.name },
        label: `${n.name}  ${formatNodeHealth(h)}`, hint: n.server });
    }
  }
  const currentEntry = current ? nodes.find((n) => n.name === current) : undefined;
  const selected = await p.select({
    message: `选择节点${current ? `（当前: ${current}）` : ''}`,
    options,
    initialValue: currentEntry
      ? options.find((o) => !o.value.group && o.value.label === currentEntry.name)?.value
      : undefined,
  });

  if (p.isCancel(selected) || (selected as { group: boolean }).group) {
    p.cancel('未选择（交互取消或当前环境不支持交互式选择——终端运行，或用 --node <节点名>）');
    process.exit(1);
  }
  const nodeName = (selected as { label: string }).label;
  await applyPick(nodeName, apiPort, nodes, secret);
}

/** 选中后共享路径：校验存在 → 落库 → 热切换 → 结果输出 */
async function applyPick(
  nodeName: string, apiPort: number, nodes?: NodeEntry[], secret = '',
): Promise<void> {
  if (nodes && !nodes.some((n) => n.name === nodeName)) {
    p.cancel(`节点不存在: ${nodeName}（可用节点见 bun-clash nodes 交互列表）`);
    process.exit(1);
  }
  const path = await writeSelectedNode(nodeName);
  const reload = await hotReload(apiPort, secret);
  const hot = reload === 'reloaded' ? await hotSwitch(apiPort, nodeName, secret) : reload;
  const note =
    hot === 'switched'
      ? `已写入 ${path}，订阅已刷新并热切换生效（无需重启）`
      : hot === 'not-running'
        ? `已写入 ${path}（内核未运行，下次启动生效）`
        : `已写入 ${path}，但热切换失败（内核运行中但切换未成功，重启后生效）`;
  if (hot === 'failed') {
    p.cancel(note);
    process.exitCode = 1;
  } else {
    p.outro(`✓ 节点: ${nodeName}\n${note}`);
  }
}
