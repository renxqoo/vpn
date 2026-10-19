/** start --daemon 后台守护（docs/daemon.md）：spawn detached 子进程 + 就绪握手 + 早退/超时报告。 */
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { KERNEL_LOG_PATH } from '../config/paths.ts';
import { readRunningController } from '../config/controller.ts';
import { logger } from '../core/log.ts';

const log = logger('daemon');

/** waitForReady 的注入面：单测用手动推进的替身，不真起进程 */
export interface ReadyController {
  pid: number;
  apiPort: number;
  secret: string;
  daemon?: boolean;
}

export interface WaitDeps {
  child: { pid: number; exited: Promise<number>; kill(sig?: number | string): void };
  readController: () => Promise<ReadyController | null>;
  alive: (pid: number) => Promise<boolean>;
  timeoutMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type ReadyResult =
  | { ready: true; controller: ReadyController }
  | { ready: false; reason: 'early-exit'; code: number }
  | { ready: false; reason: 'timeout' };

/** 轮询 controller.json：子进程 pid 匹配且存活即就绪；早退/超时先行则失败。 */
export async function waitForReady(deps: WaitDeps): Promise<ReadyResult> {
  const { child, readController, alive, timeoutMs, pollMs } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? Bun.sleep;
  const deadline = now() + timeoutMs;
  let exited: number | null = null;
  child.exited.then((code) => { exited = code; }, () => { exited = 1; });

  while (true) {
    if (exited !== null) return { ready: false, reason: 'early-exit', code: exited };
    const controller = await readController().catch(() => null);
    if (controller && controller.pid === child.pid && await alive(child.pid)) {
      return { ready: true, controller };
    }
    if (now() >= deadline) {
      child.kill('SIGTERM');
      return { ready: false, reason: 'timeout' };
    }
    await sleep(pollMs);
  }
}

const TAIL_LINES = 15;

function logTail(path: string): string {
  try {
    const text = readFileSync(path, 'utf8').trimEnd();
    if (!text) return '';
    return text.split('\n').slice(-TAIL_LINES).join('\n');
  } catch (_e) {
    return '';
  }
}

export interface DaemonStartOptions {
  entry: string;
  args: string[];
  logPath?: string;
  spawnFn?: typeof Bun.spawn;
  env?: Record<string, string | undefined>;
}

/** 后台启动：detached 子进程写日志，就绪后父进程退出（退出码与文案见 docs/daemon.md 契约）。 */
export async function runDaemonStart(opts: DaemonStartOptions): Promise<void> {
  const logPath = opts.logPath ?? KERNEL_LOG_PATH();
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  const spawn = opts.spawnFn ?? Bun.spawn;
  // unref：运行时支持但 SpawnOptions 类型未声明；子进程句柄不得钉住父进程事件循环
  const child = spawn([process.execPath, opts.entry, 'start', ...opts.args], {
    detached: true, unref: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, ...opts.env, BUN_CLASH_DAEMON: '1' },
  } as unknown as Parameters<typeof spawn>[1]);
  try {
    const result = await waitForReady({
      child,
      readController: readRunningController,
      alive: (pid) => import('../system/process.ts').then((m) => m.processAlive(pid)),
      timeoutMs: 60_000,
      pollMs: 100,
    });
    if (result.ready) {
      log.info(`后台守护已就绪：内核 PID ${result.controller.pid}，API 127.0.0.1:${result.controller.apiPort}`);
      log.info(`日志：${logPath}（bun-clash stop 停止）`);
      // 子进程句柄会钉住父进程事件循环（unref 在此场景不完全生效），就绪即退出
      process.exit(0);
    }
    if (result.reason === 'early-exit') {
      const tail = logTail(logPath);
      const where = tail ? `─── 日志尾 ${logPath} ───\n${tail}` : `（无日志输出，见 ${logPath}）`;
      throw new Error(`后台启动失败：内核进程提前退出（exit ${result.code}）\n${where}`);
    }
    throw new Error(`后台启动超时（60s 未就绪），已发送 SIGTERM；日志：${logPath}`);
  } finally {
    try { closeSync(fd); } catch (_e) { /* 子进程已继承 fd */ }
  }
}
