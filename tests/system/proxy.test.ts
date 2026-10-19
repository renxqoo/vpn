import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemProxyManager } from '../../src/system/proxy.ts';
import { FakeNetwork, initialService, testSystemLock } from '../helpers/system-proxy-fake.ts';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'vpn-system-proxy-'));
  const path = join(root, 'state.json');
  const network = new FakeNetwork();
  const manager = new SystemProxyManager({ path, run: network.run, platform: 'darwin', acquire: testSystemLock });
  return { root, path, network, manager, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('enable saves originals first, sets actual ports, and restores PAC and empty defaults', async () => {
  const { path, network, manager, cleanup } = setup();
  network.services.Disabled = initialService();
  network.disabled.add('Disabled');
  const oddName = "Office ' ; $(literal)";
  network.services[oddName] = initialService();
  const original = structuredClone(network.services);
  network.changed = () => { expect(existsSync(path)).toBe(true); };
  try {
    expect(await manager.enable(17890, 17891)).toBe(true);
    for (const name of ['Wi-Fi', oddName]) {
      const s = network.services[name]!;
      expect(s.http).toMatchObject({ enabled: true, server: '127.0.0.1', port: 17890 });
      expect(s.https.port).toBe(17890);
      expect(s.socks.port).toBe(17891);
      expect(s.pac.enabled).toBe(false);
      expect(s.discovery).toBe(false);
    }
    expect(network.services.Disabled!).toEqual(original.Disabled!);
    expect(network.calls.some((args) => args[1] === oddName)).toBe(true);
    expect(await manager.disable()).toBe(true);
    expect(network.services).toEqual(original);
    expect(existsSync(path)).toBe(false);
    const calls = network.calls.length;
    expect(await manager.disable()).toBe(false);
    expect(network.calls.length).toBe(calls);
  } finally { cleanup(); }
});

test('partial enable failure rolls back, while failed restore retains snapshot and supports retry', async () => {
  const { path, network, manager, cleanup } = setup();
  const original = structuredClone(network.services);
  let failed = false;
  try {
    network.fail = (args) => {
      if (args[0] === '-setsecurewebproxy' && !failed) { failed = true; return true; }
      return false;
    };
    await expect(manager.enable(7890, 7891)).rejects.toThrow('injected');
    expect(network.services).toEqual(original);
    expect(existsSync(path)).toBe(false);
    network.fail = undefined;
    await manager.enable(7890, 7891);
    network.fail = (args) => args[0] === '-setwebproxy';
    await expect(manager.disable()).rejects.toThrow('restore incomplete');
    expect(existsSync(path)).toBe(true);
    network.fail = undefined;
    expect(await manager.disable()).toBe(true);
    expect(network.services).toEqual(original);
  } finally { cleanup(); }
});

test('manual changes survive, active ownership rejects enable, and stale state is recovered', async () => {
  const { path, network, manager, cleanup } = setup();
  try {
    await manager.enable(7890, 7891);
    await expect(manager.enable(9000, 9001)).rejects.toThrow('running process');
    expect(await manager.disable(process.pid + 1)).toBe(false);
    network.services['Wi-Fi']!.http = {
      enabled: true, server: 'changed.example', port: 8080, authenticated: false,
    };
    network.services['Wi-Fi']!.pac.url = 'https://changed.example/new.pac';
    const state = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    state.pid = 2147483647;
    writeFileSync(path, JSON.stringify(state));
    await manager.enable(9000, 9001);
    const recovered = JSON.parse(readFileSync(path, 'utf8')) as { services: { http: { server: string } }[] };
    expect(recovered.services[0]?.http.server).toBe('changed.example');
    await manager.disable();
    expect(network.services['Wi-Fi']!.http.server).toBe('changed.example');
    expect(network.services['Wi-Fi']!.pac).toEqual({ enabled: false, url: 'https://changed.example/new.pac' });
  } finally { cleanup(); }
});

test('authenticated proxies and malformed state are rejected before any mutation', async () => {
  const { path, network, manager, cleanup } = setup();
  try {
    network.services['Wi-Fi']!.http.authenticated = true;
    await expect(manager.enable(7890, 7891)).rejects.toThrow('authenticated');
    expect(network.calls.some((args) => args[0]?.startsWith('-set'))).toBe(false);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '{invalid');
    await expect(manager.disable()).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  } finally { cleanup(); }
});

test('concurrent system operations reject clearly and release the lock after failure', async () => {
  const { path, network, cleanup } = setup();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const manager = new SystemProxyManager({ path, platform: 'darwin', acquire: testSystemLock, run: async (args) => {
    if (args[0] === '-listallnetworkservices') { entered(); await pending; }
    return network.run(args);
  } });
  try {
    const first = manager.enable(7890, 7891);
    await started;
    await expect(manager.enable(9000, 9001)).rejects.toThrow('busy');
    release();
    await first;
    await manager.disable();
  } finally { release(); cleanup(); }
});

test('unsupported systems do not execute network commands', async () => {
  const { path, network, cleanup } = setup();
  try {
    const manager = new SystemProxyManager({ path, platform: 'linux', run: network.run });
    expect(await manager.enable(7890, 7891)).toBe(false);
    expect(await manager.disable()).toBe(false);
    expect(network.calls).toHaveLength(0);
  } finally { cleanup(); }
});

test('empty and dead legacy lock files do not prevent future operations', async () => {
  const { path, manager, cleanup } = setup();
  try {
    writeFileSync(`${path}.lock`, '');
    writeFileSync(`${path}.lock.recovery`, JSON.stringify({ pid: 2147483647, token: 'dead' }));
    expect(await manager.enable(7890, 7891)).toBe(true);
    await manager.disable();
    expect(await manager.enable(9000, 9001)).toBe(true);
    await manager.disable();
  } finally { cleanup(); }
});

test('retry completes the original disabled state after restoring its address succeeded', async () => {
  const { path, network, manager, cleanup } = setup();
  network.services['Wi-Fi']!.https = {
    enabled: false, server: 'old.example', port: 8080, authenticated: false,
  };
  const original = structuredClone(network.services);
  try {
    await manager.enable(7890, 7891);
    network.fail = (args) => args[0] === '-setsecurewebproxystate';
    await expect(manager.disable()).rejects.toThrow('restore incomplete');
    expect(network.services['Wi-Fi']!.https).toMatchObject({ server: 'old.example', enabled: true });
    expect(JSON.parse(readFileSync(path, 'utf8')).restoring).toContain('0:https');
    network.fail = undefined;
    expect(await manager.disable()).toBe(true);
    expect(network.services).toEqual(original);
    expect(existsSync(path)).toBe(false);
  } finally { cleanup(); }
});

test('stale snapshot with a reused PID is recovered when process birth differs', async () => {
  const { path, manager, cleanup } = setup();
  try {
    await manager.enable(7890, 7891);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (process.platform === 'win32') state.pid = 2147483647;
    else state.birth = 'previous process birth';
    writeFileSync(path, JSON.stringify(state));
    await manager.enable(9000, 9001);
    expect(JSON.parse(readFileSync(path, 'utf8')).httpPort).toBe(9000);
    await manager.disable();
  } finally { cleanup(); }
});
