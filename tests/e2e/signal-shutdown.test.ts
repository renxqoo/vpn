import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

interface Child {
  pid: number;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

async function startChild(home: string, port: number): Promise<Child> {
  return Bun.spawn([process.execPath, CLI, 'start', '--no-system-proxy',
    '--mixed-port', String(port), '--api-port', '0'], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: 'pipe', stderr: 'pipe',
  }) as unknown as Child;
}

async function waitReady(child: Child, home: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = existsSync(join(home, '.vpn', 'logs', 'kernel.log'))
      ? readFileSync(join(home, '.vpn', 'logs', 'kernel.log'), 'utf8')
      : '';
    void text;
    try {
      const controller = JSON.parse(readFileSync(join(home, '.vpn', 'controller.json'), 'utf8')) as { pid: number };
      if (controller.pid === child.pid) return;
    } catch (_e) { /* not yet */ }
    const exited = await Promise.race([child.exited, Bun.sleep(150).then(() => null)]);
    if (exited !== null) throw new Error(`kernel exited early: ${exited}`);
  }
  throw new Error('kernel not ready in time');
}

for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
  test(`start restores clean state on ${signal} (no orphaned controller/journal)`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'vpn-signal-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = await startChild(home, port);
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
