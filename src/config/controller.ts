/** 启动进程记录实际控制端点，订阅更新不能改变已有监听器的寻址。 */
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_CONFIG_DIR } from './paths.ts';
import { processAlive, processBirth } from '../system/process.ts';

interface Controller {
  pid: number;
  apiPort: number;
  secret: string;
  birth?: string;
  daemon?: boolean;
}

const controllerPath = () => join(HOME_CONFIG_DIR(), 'controller.json');

export async function writeController(apiPort: number, secret: string, daemon = false): Promise<void> {
  const birth = await processBirth(process.pid);
  await Bun.write(controllerPath(),
    JSON.stringify({ pid: process.pid, birth, apiPort, secret, daemon }), { createPath: true });
  chmodSync(controllerPath(), 0o600);
}

export async function readRunningController(): Promise<Controller | null> {
  try {
    const value = await Bun.file(controllerPath()).json() as Partial<Controller> | null;
    if (!value || !Number.isInteger(value.pid) || !Number.isInteger(value.apiPort) ||
      value.pid! <= 0 || value.apiPort! < 1 || value.apiPort! > 65535 || typeof value.secret !== 'string') return null;
    if (value.birth !== undefined && (typeof value.birth !== 'string' || value.birth.length > 200)) return null;
    if (value.daemon !== undefined && typeof value.daemon !== 'boolean') return null;
    if (!(await processAlive(value.pid!, value.birth))) return null;
    return value as Controller;
  } catch (_e) {
    return null;
  }
}

export async function resolveController(
  fallbackPort: number, fallbackSecret: string, explicitPort?: number,
): Promise<{ apiPort: number; secret: string; daemon?: boolean; pid?: number }> {
  const running = await readRunningController();
  if (running && (explicitPort === undefined || explicitPort === running.apiPort)) return running;
  return { apiPort: explicitPort ?? fallbackPort, secret: fallbackSecret };
}

export async function clearController(): Promise<void> {
  const file = Bun.file(controllerPath());
  if (!(await file.exists())) return;
  const state = await file.json() as Partial<Controller>;
  if (state.pid === process.pid) rmSync(controllerPath(), { force: true });
}
