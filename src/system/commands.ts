/** 系统代理关闭与内核停止命令；不向未验证的 PID 发送信号。 */
import * as p from '@clack/prompts';
import { collectFileInputs, mergeSource } from '../config/settings.ts';
import { readRunningController, resolveController } from '../config/controller.ts';
import { createSystemProxyManager } from './proxy.ts';

async function controlEndpoint(apiPortArg?: number) {
  const src = mergeSource(await collectFileInputs());
  const controller = await resolveController(src.apiPort ?? 9090, src.secret ?? '', apiPortArg);
  const base = `http://127.0.0.1:${controller.apiPort}`;
  const headers = controller.secret ? { authorization: `Bearer ${controller.secret}` } : undefined;
  let response: Response;
  try { response = await fetch(`${base}/version`, { headers, signal: AbortSignal.timeout(1500) }); }
  catch (_e) { return { base, headers, running: false }; }
  if (!response.ok) throw new Error('内核 API 鉴权失败或不可用，未修改系统代理');
  return { base, headers, running: true };
}

export async function runProxyOffCommand(): Promise<void> {
  await createSystemProxyManager().disable();
  p.outro('系统代理已恢复；内核运行状态不变');
}

export async function runStopCommand(apiPortArg?: number): Promise<void> {
  const endpoint = await controlEndpoint(apiPortArg);
  if (!endpoint.running) {
    await createSystemProxyManager().disable();
    if (await readRunningController()) throw new Error('系统代理已恢复，但内核 API 不可达，无法确认内核已停止');
    p.outro('系统代理已恢复；内核未运行');
    return;
  }
  const response = await fetch(`${endpoint.base}/shutdown`, {
    method: 'POST', headers: endpoint.headers, signal: AbortSignal.timeout(90_000),
  });
  if (response.status !== 204 && response.status !== 409) {
    if (response.status === 404 || response.status === 501) {
      throw new Error('旧内核不支持 stop，请在原终端 Ctrl-C 退出后用新版 start 启动');
    }
    throw new Error('停止失败，内核保留运行；请修复系统代理权限后重试');
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await fetch(`${endpoint.base}/version`, { headers: endpoint.headers, signal: AbortSignal.timeout(500) }); }
    catch (_e) { p.outro('系统代理已恢复，内核已停止'); return; }
    await Bun.sleep(50);
  }
  throw new Error('停止尚未完成，请稍后检查 bun-clash status');
}
