import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initialService, type FakeService } from '../helpers/system-proxy-fake.ts';

const cli = resolve(import.meta.dir, '../../src/cli.ts');
const preload = resolve(import.meta.dir, '../fixtures/system-proxy-preload.ts');
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'vpn-system-e2e-'));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  const spawn = (...args: string[]) => Bun.spawn([process.execPath, '--preload', preload, cli, ...args], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const command = async (...args: string[]) => {
    const child = spawn(...args);
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, text: stdout + stderr };
  };
  const state = () => JSON.parse(readFileSync(join(root, 'fake-network.json'), 'utf8')) as Record<string, FakeService>;
  const snapshot = join(root, '.vpn/system-proxy.json');
  const controller = join(root, '.vpn/controller.json');
  return { root, spawn, command, state, snapshot, controller,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20); }
  throw new Error('condition timed out');
}

test('start enables real listener ports; proxy off leaves kernel running; stop restores and closes it', async () => {
  const h = harness();
  const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    await waitFor(() => existsSync(h.controller));
    const controller = JSON.parse(readFileSync(h.controller, 'utf8')) as { apiPort: number };
    const base = `http://127.0.0.1:${controller.apiPort}`;
    const service = h.state()['Wi-Fi']!;
    expect(service.http.enabled).toBe(true);
    expect(service.https.port).toBe(service.http.port);
    expect(service.http.port).toBeGreaterThan(0);
    expect(service.socks.port).toBeGreaterThan(0);
    const tunnel = await Bun.connect({ hostname: '127.0.0.1', port: service.http.port, socket: { data() {} } });
    tunnel.end();
    expect((await h.command('stop', '--api-port', 'NaN')).code).toBe(1);
    expect(h.state()['Wi-Fi']!.http.enabled).toBe(true);
    expect((await fetch(`${base}/version`)).status).toBe(200);
    const off = await h.command('proxy', 'off');
    expect(off.code).toBe(0);
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect((await fetch(`${base}/version`)).status).toBe(200);
    expect(existsSync(h.snapshot)).toBe(false);
    const stopped = await h.command('stop');
    expect(stopped.code).toBe(0);
    expect(stopped.text).toContain('内核已停止');
    expect(await kernel.exited).toBe(0);
    expect(existsSync(h.controller)).toBe(false);
    await expect(fetch(`${base}/version`)).rejects.toThrow();
    expect((await h.command('stop')).code).toBe(0);
    expect((await h.command('proxy', 'off')).code).toBe(0);
  } finally {
    if (kernel.exitCode === null) { kernel.kill(); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 15000 });

// Windows 不支持通过 child.kill 投递可捕获的 POSIX 信号；在该平台验证 API 优雅退出。
const signals = process.platform === 'win32' ? ['API'] as const : ['SIGINT', 'SIGTERM'] as const;
for (const signal of signals) {
  test(`start restores original proxies on ${signal}`, async () => {
    const h = harness();
    const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
    try {
      await waitFor(() => existsSync(h.controller));
      expect(existsSync(h.snapshot)).toBe(true);
      if (signal === 'API') expect((await h.command('stop')).code).toBe(0);
      else kernel.kill(signal);
      expect(await kernel.exited).toBe(0);
      expect(h.state()['Wi-Fi']!).toEqual(initialService());
      expect(existsSync(h.snapshot)).toBe(false);
      expect(existsSync(h.controller)).toBe(false);
    } finally {
      if (kernel.exitCode === null) { kernel.kill(); await kernel.exited; }
      h.cleanup();
    }
  }, { timeout: 10000 });
}

test('system setup failure rolls back and releases all kernel listeners', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'fake-fail-once'), '-setsecurewebproxy');
  try {
    const result = await h.command('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
    expect(result.code).toBe(1);
    expect(result.text).toContain('injected');
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect(existsSync(h.snapshot)).toBe(false);
    expect(existsSync(h.controller)).toBe(false);
  } finally { h.cleanup(); }
}, { timeout: 10000 });

test('--no-system-proxy leaves system settings untouched and still supports stop', async () => {
  const h = harness();
  const kernel = h.spawn(
    'start', '--no-system-proxy', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0',
  );
  try {
    await waitFor(() => existsSync(h.controller));
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect(existsSync(h.snapshot)).toBe(false);
    expect(existsSync(join(h.root, 'fake-network-calls.json'))).toBe(false);
    expect((await h.command('stop')).code).toBe(0);
    expect(await kernel.exited).toBe(0);
  } finally {
    if (kernel.exitCode === null) { kernel.kill(); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 10000 });

test('crashed kernel leaves a recoverable snapshot; proxy off restores it without a live API', async () => {
  const h = harness();
  const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    await waitFor(() => existsSync(h.controller));
    kernel.kill('SIGKILL');
    await kernel.exited;
    expect(existsSync(h.snapshot)).toBe(true);
    expect((await h.command('proxy', 'off')).code).toBe(0);
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect(existsSync(h.snapshot)).toBe(false);
  } finally {
    if (kernel.exitCode === null) { kernel.kill(); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 10000 });

test('failed stop retains the live kernel and snapshot, and a subsequent stop retries restoration', async () => {
  const h = harness();
  const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    await waitFor(() => existsSync(h.controller));
    const { apiPort } = JSON.parse(readFileSync(h.controller, 'utf8')) as { apiPort: number };
    writeFileSync(join(h.root, 'fake-fail-restore'), '1');
    expect((await h.command('stop')).code).toBe(1);
    expect(existsSync(h.snapshot)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${apiPort}/version`)).status).toBe(200);
    rmSync(join(h.root, 'fake-fail-restore'));
    expect((await h.command('stop')).code).toBe(0);
    expect(await kernel.exited).toBe(0);
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
  } finally {
    if (kernel.exitCode === null) { kernel.kill('SIGKILL'); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 10000 });

test('crash during system mutation releases the operation lock and allows offline recovery', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'fake-pause-after'), '-setwebproxy');
  const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    await waitFor(() => existsSync(join(h.root, 'fake-paused')));
    expect(existsSync(h.snapshot)).toBe(true);
    expect(h.state()['Wi-Fi']!.http.server).toBe('127.0.0.1');
    if (process.platform === 'darwin') expect((await h.command('proxy', 'off')).code).toBe(1);
    kernel.kill('SIGKILL');
    await kernel.exited;
    rmSync(join(h.root, 'fake-pause-after'));
    await waitFor(async () => (await h.command('proxy', 'off')).code === 0);
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect(existsSync(h.snapshot)).toBe(false);
  } finally {
    if (kernel.exitCode === null) { kernel.kill('SIGKILL'); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 10000 });

test('recovery waits for a native setter that outlives its crashed parent', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'fake-delayed-native'), '1');
  const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    await waitFor(() => existsSync(join(h.root, 'fake-native-started')));
    kernel.kill('SIGKILL');
    await kernel.exited;
    rmSync(join(h.root, 'fake-delayed-native'));
    if (process.platform === 'darwin') expect((await h.command('proxy', 'off')).code).toBe(1);
    expect(existsSync(h.snapshot)).toBe(true);
    await waitFor(() => existsSync(join(h.root, 'fake-native-finished')));
    await waitFor(async () => (await h.command('proxy', 'off')).code === 0);
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect(existsSync(h.snapshot)).toBe(false);
  } finally {
    if (kernel.exitCode === null) { kernel.kill('SIGKILL'); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 10000 });

test('setup plus rollback failure keeps a usable kernel until system recovery succeeds', async () => {
  const h = harness();
  writeFileSync(join(h.root, 'fake-fail-once'), '-setsecurewebproxy');
  writeFileSync(join(h.root, 'fake-fail-restore'), '1');
  const kernel = h.spawn('start', '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    await waitFor(() => existsSync(h.controller));
    const { apiPort } = JSON.parse(readFileSync(h.controller, 'utf8')) as { apiPort: number };
    expect(existsSync(h.snapshot)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${apiPort}/version`)).status).toBe(200);
    rmSync(join(h.root, 'fake-fail-restore'));
    expect((await h.command('stop')).code).toBe(0);
    expect(await kernel.exited).toBe(0);
    expect(h.state()['Wi-Fi']!).toEqual(initialService());
    expect(await new Response(kernel.stderr).text()).toContain('已保留内核');
  } finally {
    if (kernel.exitCode === null) { kernel.kill('SIGKILL'); await kernel.exited; }
    h.cleanup();
  }
}, { timeout: 10000 });
