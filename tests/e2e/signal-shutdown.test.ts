import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

async function startChild(home: string): Promise<ChildHandle> {
  return Bun.spawn(
    [process.execPath, CLI, 'start', '--no-system-proxy',
      '--direct', '--mixed-port', '0', '--api-port', '0'],
    {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe',
    },
  );
}

interface ChildHandle {
  pid: number;
  exited: Promise<number>;
}

async function waitReady(child: ChildHandle, home: string, timeoutMs = 15_000): Promise<void> {
  const controllerPath = join(home, '.vpn', 'controller.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = JSON.parse(readFileSync(controllerPath, 'utf8')) as { pid: number };
      if (controller.pid === child.pid) return;
    } catch (_e) { /* not yet */ }
    const exited = await Promise.race([child.exited, Bun.sleep(150).then(() => null)]);
    if (exited !== null) throw new Error(`kernel exited early: ${exited}`);
  }
  throw new Error('kernel not ready in time');
}

// Windows 不支持通过 child.kill 投递可捕获的 POSIX 信号（见 system-proxy.test.ts 信号循环）。
const signals = process.platform === 'win32' ? [] : ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
for (const signal of signals) {
  test(`start restores clean state on ${signal} (no orphaned controller/journal)`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'vpn-signal-'));
    const child = await startChild(home);
    try {
      await waitReady(child, home);
      process.kill(child.pid, signal);
      const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => null)]);
      expect(code).not.toBeNull();
      expect(existsSync(join(home, '.vpn', 'controller.json'))).toBe(false);
    } finally {
      try { process.kill(child.pid, 'SIGKILL'); } catch (_e) { /* already dead */ }
      rmSync(home, { recursive: true, force: true });
    }
  });
}
