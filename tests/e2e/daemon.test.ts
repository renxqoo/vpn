import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** e2e：bun-clash start --daemon 全旅程（temp HOME + 本地订阅源，零外网） */
const CLI = resolve(import.meta.dir, '../../src/cli.ts');

interface SubServer {
  port: number;
  stop(): void;
}

function subscriptionServer(): SubServer {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('log-level: silent\nrules:\n  - MATCH,DIRECT\n'),
  });
  if (server.port === undefined) throw new Error('no port');
  return { port: server.port, stop: () => server.stop(true) };
}

function spawnCli(args: string[], home: string) {
  return Bun.spawn([process.execPath, CLI, ...args], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
}

interface DrainResult {
  code: number;
  out: string;
  err: string;
}

async function drain(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<DrainResult> {
  const [code, out, err] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  return { code, out, err };
}

async function apiUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch (_e) { return false; }
}

async function shutdownDaemon(home: string): Promise<void> {
  const proc = spawnCli(['stop'], home);
  await drain(proc);
}

test('daemon happy path: spawn, ready, detached child survives, status shows daemon mode, clean shutdown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-daemon-happy-'));
  const sub = subscriptionServer();
  try {
    await Bun.write(join(home, '.vpn/config.yaml'),
      `subscription-url: 'http://127.0.0.1:${sub.port}/sub'\n`, { createPath: true });
    const parent = spawnCli(
      ['start', '--daemon', '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'], home);
    const { code, out } = await drain(parent);
    expect(code).toBe(0);
    expect(out).toContain('后台');

    const controller = JSON.parse(readFileSync(join(home, '.vpn/controller.json'), 'utf8')) as {
      pid: number; apiPort: number; daemon?: boolean;
    };
    expect(controller.daemon).toBe(true);
    // 子进程脱离父进程存活：父已退出，内核 API 仍可达
    await Bun.sleep(300);
    expect(await apiUp(controller.apiPort)).toBe(true);
    // 日志文件已落盘
    expect(readFileSync(join(home, '.vpn/logs/kernel.log'), 'utf8').length).toBeGreaterThan(0);

    // status 展示后台守护 + PID
    const status = spawnCli(['status'], home);
    const statusRes = await drain(status);
    expect(statusRes.out).toContain('后台守护');
    expect(statusRes.out).toContain(String(controller.pid));
    await shutdownDaemon(home);
    let deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await apiUp(controller.apiPort)) await Bun.sleep(100);
    expect(await apiUp(controller.apiPort)).toBe(false);
  } finally {
    sub.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('daemon start rejected when kernel already running', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-daemon-running-'));
  const sub = subscriptionServer();
  try {
    await Bun.write(join(home, '.vpn/config.yaml'),
      `subscription-url: 'http://127.0.0.1:${sub.port}/sub'\n`, { createPath: true });
    const first = spawnCli(
      ['start', '--daemon', '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'], home);
    const firstRes = await drain(first);
    expect(firstRes.code).toBe(0);
    const controller = JSON.parse(readFileSync(join(home, '.vpn/controller.json'), 'utf8')) as { apiPort: number };

    const second = spawnCli(
      ['start', '--daemon', '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'], home);
    const secondRes = await drain(second);
    expect(secondRes.code).toBe(1);
    expect(secondRes.out + secondRes.err).toContain('已在运行');

    await shutdownDaemon(home);
  } finally {
    sub.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('daemon reports early exit with log tail when HTTP port is occupied', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-daemon-early-'));
  const sub = subscriptionServer();
  const occupied = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  try {
    await Bun.write(join(home, '.vpn/config.yaml'),
      `subscription-url: 'http://127.0.0.1:${sub.port}/sub'\n`, { createPath: true });
    const parent = spawnCli(
      ['start', '--daemon', '--no-system-proxy', '--port', String(occupied.port),
        '--socks-port', '0', '--api-port', '0'], home);
    const { code, out, err } = await drain(parent);
    expect(code).toBe(1);
    expect(out + err).toContain('监听失败');
    expect(out + err).toContain(`127.0.0.1:${occupied.port}`);
    // 日志尾随错误输出（fatal 附尾行）
    expect((out + err).includes('kernel.log') || (out + err).includes('───')).toBe(true);
  } finally {
    occupied.stop(true);
    sub.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
