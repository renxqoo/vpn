/**
 * `bun run usage`：订阅剩余用量展示（design.md §1.1 交互式 CLI）。
 */

import * as p from '@clack/prompts';
import { fetchUserinfo, renderUsage } from './usage.ts';
import { collectFileInputs, mergeSource } from './settings.ts';

export async function runUsageCommand(): Promise<void> {
  const src = mergeSource(await collectFileInputs());
  if (!src.subscriptionUrl) {
    p.intro('bun-clash 订阅用量');
    p.cancel('未配置订阅地址（.env 或 bun run config set-subscription）');
    process.exit(1);
  }
  p.intro('bun-clash 订阅用量');
  const result = await fetchUserinfo(src.subscriptionUrl);
  if (result.kind === 'network-error') {
    p.cancel(`订阅拉取失败（网络问题，非服务端能力缺失）：${result.error}`);
    process.exit(1);
  }
  if (result.kind === 'unsupported') {
    p.cancel('订阅服务端未返回 subscription-userinfo 头（可能不支持用量查询）');
    process.exit(1);
  }
  const lines = renderUsage(result.usage, 'plain');
  for (const line of lines) {
    p.log.message(line);
  }
  p.outro('数据来自订阅响应头 subscription-userinfo');
}
