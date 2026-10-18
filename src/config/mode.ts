/**
 * `bun-clash mode`：代理模式选择（规则/全局/直连；design.md §1.1 第三批）。
 * 写 ~/.vpn/config.yaml 的 mode 键；内核运行中（API 可达）时 PATCH /configs 热切换。
 */

import * as p from '@clack/prompts';

export type ModeName = 'rule' | 'global' | 'direct';

export const MODE_LABELS: Record<ModeName, string> = {
  rule: '规则（按订阅规则分流）',
  global: '全局（全部流量走代理节点）',
  direct: '直连（不走任何代理节点）',
};

/** 读家目录配置的 mode（缺省 rule） */
export async function readMode(): Promise<ModeName> {
  const { HOME_CONFIG_PATH } = await import('./paths.ts');
  const f = Bun.file(HOME_CONFIG_PATH());
  if (!(await f.exists())) return 'rule';
  const m = /^mode:\s*(\w+)/m.exec(await f.text());
  const v = m?.[1];
  return v === 'global' || v === 'direct' || v === 'rule' ? v : 'rule';
}

/** 写 mode 键（保留其余行） */
export async function writeMode(mode: ModeName): Promise<string> {
  const { HOME_CONFIG_PATH } = await import('./paths.ts');
  const path = HOME_CONFIG_PATH();
  const f = Bun.file(path);
  let text = (await f.exists()) ? await f.text() : '';
  if (/^mode:.*$/m.test(text)) {
    text = text.replace(/^mode:.*$/m, `mode: ${mode}`);
  } else {
    text = `mode: ${mode}\n${text}`;
  }
  await Bun.write(path, text, { createPath: true });
  return path;
}

/** 热切换：PATCH /configs {"mode":...}；返回 switched / not-running / failed */
export async function hotSwitchMode(apiPort: number, mode: ModeName): Promise<'switched' | 'not-running' | 'failed'> {
  try {
    const probe = await fetch(`http://127.0.0.1:${apiPort}/version`, { signal: AbortSignal.timeout(1500) });
    if (!probe.ok) return 'not-running';
  } catch (_e) {
    return 'not-running';
  }
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/configs`, {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json' },
    });
    return res.status === 204 ? 'switched' : 'failed';
  } catch (_e) {
    return 'failed';
  }
}

export async function runModeCommand(apiPortArg?: number, directSet?: string): Promise<void> {
  const current = await readMode();
  if (directSet !== undefined) {
    if (directSet !== 'rule' && directSet !== 'global' && directSet !== 'direct') {
      console.error(`无效模式: ${directSet}（可选 rule | global | direct）`);
      process.exit(1);
    }
    const path = await writeMode(directSet);
    const hot = await hotSwitchMode(apiPortArg ?? 9090, directSet);
    const note =
      hot === 'switched'
        ? '已写入配置并热切换生效'
        : hot === 'not-running'
          ? `已写入 ${path}（内核未运行，下次启动生效）`
          : `已写入 ${path}，热切换失败（重启后生效）`;
    console.log(`✓ 模式: ${MODE_LABELS[directSet]}\n${note}`);
    return;
  }
  p.intro('bun-clash 代理模式');
  const selected = await p.select({
    message: `选择模式（当前: ${MODE_LABELS[current]}）`,
    options: (Object.keys(MODE_LABELS) as ModeName[]).map((m) => ({
      value: m,
      label: MODE_LABELS[m],
    })),
    initialValue: current,
  });
  if (p.isCancel(selected)) {
    p.cancel('未更改');
    process.exit(0);
  }
  const mode = selected as ModeName;
  if (mode === current) {
    const hot = await hotSwitchMode(apiPortArg ?? 9090, mode);
    p.outro(`模式未变（${mode}）${hot === 'switched' ? '，已确认运行中内核同步' : ''}`);
    return;
  }
  const path = await writeMode(mode);
  const hot = await hotSwitchMode(apiPortArg ?? 9090, mode);
  const note =
    hot === 'switched'
      ? '已写入配置并热切换生效（无需重启）'
      : hot === 'not-running'
        ? `已写入 ${path}（内核未运行，下次启动生效）`
        : `已写入 ${path}，但热切换失败（重启后生效）`;
  p.outro(`✓ 模式: ${MODE_LABELS[mode]}\n${note}`);
}
