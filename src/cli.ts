#!/usr/bin/env bun
/**
 * bun-clash CLI 入口（design.md §1.1 第三批）：单一 bin，子命令分发。
 * dev：bun run cli <cmd>；发布后：bun-clash <cmd>
 */

import { runStart } from './start.ts';
import { runConfigCommand } from './config-cmd.ts';

interface Command {
  name: string;
  summary: string;
  run(args: string[]): Promise<void>;
}

function findApiPort(args: string[]): number | undefined {
  const i = args.indexOf('--api-port');
  if (i < 0) return undefined;
  const port = Number(args[i + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--api-port 必须是 1–65535 的整数');
  return port;
}

const commands: Command[] = [
  {
    name: 'start',
    summary: '启动内核并开启系统代理（macOS；--no-system-proxy 跳过）',
    async run(args) {
      await runStart(args);
    },
  },
  {
    name: 'stop',
    summary: '恢复系统代理并停止内核',
    async run(args) {
      if (args.length !== 0 && (args.length !== 2 || args[0] !== '--api-port')) {
        throw new Error('用法：bun-clash stop [--api-port PORT]');
      }
      const { runStopCommand } = await import('./system/commands.ts');
      await runStopCommand(findApiPort(args));
    },
  },
  {
    name: 'proxy',
    summary: 'proxy off：仅关闭系统代理，保留内核',
    async run(args) {
      if (args.length !== 1 || args[0] !== 'off') throw new Error('用法：bun-clash proxy off');
      const { runProxyOffCommand } = await import('./system/commands.ts');
      await runProxyOffCommand();
    },
  },
  {
    name: 'nodes',
    summary: '选择节点；--list 查看全部状态；--check 刷新延迟',
    async run(args) {
      const seen = new Set<string>();
      for (let i = 0; i < args.length; i++) {
        const flag = args[i]!;
        if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
        seen.add(flag);
        if (flag === '--node' || flag === '--api-port') {
          if (!args[++i] || args[i]!.startsWith('--')) throw new Error(`${flag} 缺少参数`);
        } else if (flag !== '--list' && flag !== '--check') throw new Error(`未知参数: ${flag}`);
      }
      if (seen.has('--list') && (seen.has('--check') || seen.has('--node'))) {
        throw new Error('--list 不能与 --check / --node 同时使用');
      }
      const { runNodesCommand } = await import('./config/nodes.ts');
      const nodeFlag = args.indexOf('--node');
      const directPick = nodeFlag >= 0 ? (args[nodeFlag + 1] as string) : undefined;
      await runNodesCommand(findApiPort(args), directPick,
        seen.has('--check') ? 'check' : seen.has('--list') ? 'list' : 'select');
    },
  },
  {
    name: 'usage',
    summary: '查看订阅剩余流量与到期时间',
    async run() {
      const { runUsageCommand } = await import('./config/usage-cli.ts');
      await runUsageCommand();
    },
  },
  {
    name: 'mode',
    summary: '选择代理模式：规则 / 全局 / 直连（写配置 + 运行中热切换）',
    async run(args) {
      const { runModeCommand } = await import('./config/mode.ts');
      const setFlag = args.indexOf('--set');
      const directSet = setFlag >= 0 ? (args[setFlag + 1] as string) : undefined;
      await runModeCommand(findApiPort(args), directSet);
    },
  },
  {
    name: 'status',
    summary: '运行状态总览（模式/节点/连接/端口）',
    async run(args) {
      const { runStatusCommand } = await import('./config/status.ts');
      await runStatusCommand(findApiPort(args));
    },
  },
  {
    name: 'config',
    summary: 'set-subscription <URL> | show',
    async run(args) {
      await runConfigCommand(args);
    },
  },
];

function help(): void {
  console.log(`bun-clash — Clash 兼容代理内核 (Bun + TypeScript)

用法：bun-clash <命令> [参数]

命令：
${commands.map((c) => `  ${c.name.padEnd(18)}${c.summary}`).join('\n')}

示例：
  bun-clash start                     启动（订阅来自 ~/.vpn/config.yaml 或项目 .env）
  bun-clash stop                      恢复系统代理并停止内核
  bun-clash proxy off                 仅关闭系统代理
  bun-clash start --no-system-proxy    仅启动内核
  bun-clash nodes                     交互选择节点
  bun-clash nodes --list              查看每个节点的延迟和可用状态
  bun-clash nodes --check             手动刷新全部节点延迟（不切换节点）
  bun-clash nodes --node 台湾 01      非交互直选节点（脚本/CI 用）
  bun-clash status                    运行状态总览
  bun-clash mode                      切换 规则/全局/直连
  bun-clash usage                     订阅剩余流量
  bun-clash config set-subscription 'https://...?clash=1'
  bun-clash start --port 7890 --api-port 9090 --direct`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (!first || first === 'help' || first === '--help' || first === '-h') {
    help();
    process.exit(first ? 0 : 1);
  }
  const cmd = commands.find((c) => c.name === first);
  if (!cmd) {
    console.error(`未知命令: ${first}\n`);
    help();
    process.exit(1);
  }
  await cmd.run(argv.slice(1));
}

void main().catch((e: unknown) => {
  console.error(`fatal: ${String(e)}`);
  process.exit(1);
});
