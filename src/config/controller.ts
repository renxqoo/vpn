/** 启动进程记录实际控制端点，订阅更新不能改变已有监听器的寻址。 */
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { HOME_CONFIG_DIR } from './paths.ts';

interface Controller {
  pid: number;
  apiPort: number;
  secret: string;
}

const controllerPath = () => join(HOME_CONFIG_DIR(), 'controller.json');

export async function writeController(apiPort: number, secret: string): Promise<void> {
  await Bun.write(controllerPath(), JSON.stringify({ pid: process.pid, apiPort, secret }), { createPath: true });
  chmodSync(controllerPath(), 0o600);
}

async function readController(): Promise<Controller | null> {
  try {
    const value = await Bun.file(controllerPath()).json() as Partial<Controller> | null;
    if (!value || !Number.isInteger(value.pid) || !Number.isInteger(value.apiPort) ||
      value.pid! <= 0 || value.apiPort! < 1 || value.apiPort! > 65535 || typeof value.secret !== 'string') return null;
    process.kill(value.pid!, 0);
    return value as Controller;
  } catch (_e) {
    return null;
  }
}

export async function resolveController(
  fallbackPort: number, fallbackSecret: string, explicitPort?: number,
): Promise<{ apiPort: number; secret: string }> {
  const running = await readController();
  if (running && (explicitPort === undefined || explicitPort === running.apiPort)) return running;
  return { apiPort: explicitPort ?? fallbackPort, secret: fallbackSecret };
}
