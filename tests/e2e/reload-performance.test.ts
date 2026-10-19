import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { App } from '../../src/app.ts';
import type { ClashConfig } from '../../src/config/clash.ts';
import type { Conn } from '../../src/core/types.ts';
import { AnytlsOutbound } from '../../src/outbound/anytls/index.ts';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';
import { AutoGroup } from '../../src/rules/groups.ts';

let a: AnytlsTestServer;
let b: AnytlsTestServer;
beforeAll(async () => {
  a = new AnytlsTestServer({ password: 'a' });
  b = new AnytlsTestServer({ password: 'b' });
  await a.start();
  await b.start();
});
afterAll(() => { a.stop(); b.stop(); });
const target = { type: 'fqdn' as const, host: 'preserved.test', port: 80 };
function config(selected = 'A'): ClashConfig {
  return {
    httpPort: 0, socksPort: 0, mode: 'rule', logLevel: 'silent', apiAddr: '127.0.0.1:0', apiSecret: '',
    proxies: [a, b].map((server, i) => ({
      kind: 'anytls', name: i === 0 ? 'A' : 'B', server: '127.0.0.1', port: server.port,
      password: i === 0 ? 'a' : 'b', skipCertVerify: true, udp: false,
      idleSessionCheckIntervalSec: 30, idleSessionTimeoutSec: 30, minIdleSession: 5,
    })),
    groups: [{ name: '🚀 节点选择', type: 'select', proxies: selected === 'A' ? ['A', 'B'] : ['B', 'A'] }],
    rules: [{ type: 'MATCH', payload: '', target: '🚀 节点选择', noResolve: false, raw: '' }],
    ruleProviders: new Map(),
  };
}
async function echo(conn: Conn, text: string) {
  await conn.write(new TextEncoder().encode(text));
  expect(new TextDecoder().decode(await conn.read())).toBe(text);
}

test('reload preserves warm pools and active streams; endpoint changes drain the old client', async () => {
  const app = new App({ config: config(), cacheDir: '/tmp/bunclash-reload-perf' });
  await app.start();
  try {
    const original = app.outboundOf('A') as AnytlsOutbound;
    const conn = await original.connect(target);
    await echo(conn, 'before');
    await app.reload(config('B'));
    expect(app.outboundOf('A')).toBe(original);
    expect(original.sessionStats.active).toBe(1);
    await echo(conn, 'after-selection');
    const selector = app.outboundOf('🚀 节点选择');
    const updated = config('B');
    updated.rules = [{ type: 'MATCH', payload: '', target: 'B', noResolve: false, raw: '' }];
    await app.reload(updated);
    expect(app.outboundOf('🚀 节点选择')).toBe(selector);
    expect(app.outboundOf('A')).toBe(original);
    await echo(conn, 'after-rules');
    const changed = config();
    changed.proxies[0] = { ...changed.proxies[1]!, name: 'A' };
    await app.reload(changed);
    expect(app.outboundOf('A')).not.toBe(original);
    await echo(conn, 'old-stream-still-live');
    const newConn = await app.outboundOf('A')!.connect({ ...target, host: 'new-endpoint.test' });
    await echo(newConn, 'new-stream');
    expect(b.events.targets).toContain('new-endpoint.test:80');
    expect(a.events.targets).not.toContain('new-endpoint.test:80');
    await expect(original.connect(target)).rejects.toThrow('client closed');
    newConn.close();
    conn.close();
    expect(original.sessionStats.active).toBe(0);
  } finally { await app.stop(); }
});

test('retiring a node lets already-started TLS connections complete and stop closes draining streams', async () => {
  const app = new App({ config: config(), cacheDir: '/tmp/bunclash-reload-perf' });
  await app.start();
  try {
    const original = app.outboundOf('A') as AnytlsOutbound;
    const opening = original.connect(target);
    const changed = config();
    changed.proxies = changed.proxies.filter((p) => p.name === 'B');
    changed.groups[0]!.proxies = ['B'];
    await app.reload(changed);
    const conn = await opening;
    await echo(conn, 'pending-handshake-preserved');
    expect(original.sessionStats.active).toBe(1);
    await app.stop();
    expect(original.sessionStats.active).toBe(0);
    await expect(conn.read()).rejects.toThrow();
  } finally { await app.stop(); }
});

test('failed preparation cannot close reused client sessions', async () => {
  const app = new App({ config: config(), cacheDir: '/tmp/bunclash-reload-perf' });
  await app.start();
  const original = app.outboundOf('A') as AnytlsOutbound;
  const conn = await original.connect(target);
  const start = spyOn(AutoGroup.prototype, 'start').mockImplementation(() => { throw new Error('prepare failed'); });
  try {
    const changed = config();
    changed.groups.push({ name: 'new-auto', type: 'url-test', proxies: ['A'] });
    await expect(app.reload(changed)).rejects.toThrow('prepare failed');
    expect(app.outboundOf('A')).toBe(original);
    expect(app.outboundOf('new-auto')).toBeUndefined();
    await echo(conn, 'old-config-retained');
  } finally {
    start.mockRestore();
    conn.close();
    await app.stop();
  }
});

test('selection reload reuses automatic groups and already-loaded rule providers', async () => {
  let downloads = 0;
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    if (new URL(req.url).pathname === '/rules') downloads++;
    return new Response('payload:\n  - retained.test\n');
  } });
  const initial = config();
  initial.groups.push({ name: 'auto', type: 'url-test', proxies: ['A', 'B'] });
  initial.ruleProviders.set('retained', {
    name: 'retained', behavior: 'domain', format: 'yaml',
    url: `http://127.0.0.1:${provider.port}/rules`, interval: 3600,
  });
  initial.rules.unshift({
    type: 'RULE-SET', payload: 'retained', target: 'A', noResolve: false, raw: '',
  });
  const app = new App({ config: initial, cacheDir: '/tmp/bunclash-reload-perf' });
  await app.start();
  try {
    const ctx = { host: 'retained.test', port: 80, isIp: false };
    for (let i = 0; i < 100 && JSON.stringify(app.getEngine()!.resolve(ctx)) !== '{"outbound":"A"}'; i++) {
      await Bun.sleep(5);
    }
    const group = app.outboundOf('auto');
    const updated = { ...initial, groups: initial.groups.map((g) => ({ ...g, proxies: [...g.proxies] })) };
    updated.groups[0]!.proxies.reverse();
    await app.reload(updated);
    expect(app.outboundOf('auto')).toBe(group);
    expect(app.getEngine()!.resolve(ctx)).toEqual({ outbound: 'A' });
    expect(downloads).toBe(1);
    const added = { ...updated, ruleProviders: new Map(updated.ruleProviders) };
    added.ruleProviders.set('new-provider', {
      name: 'new-provider', behavior: 'domain', format: 'yaml',
      url: `http://127.0.0.1:${provider.port}/new`, interval: 3600,
    });
    await app.reload(added);
    expect(app.getEngine()!.resolve(ctx)).toEqual({ outbound: 'A' });
    await Bun.sleep(20);
    expect(downloads).toBe(1);
  } finally {
    await app.stop();
    provider.stop(true);
  }
});

for (const type of ['select', 'fallback'] as const) {
  test(`${type} group drops a member that becomes unsupported instead of reusing a retired node`, async () => {
    const initial = config();
    initial.groups[0] = { name: '🚀 节点选择', type, proxies: ['B', 'A'] };
    const app = new App({ config: initial, cacheDir: '/tmp/bunclash-reload-perf' });
    await app.start();
    try {
      const before = app.outboundOf('🚀 节点选择');
      const next = config();
      next.groups[0] = { ...initial.groups[0]!, proxies: ['B', 'A'] };
      next.proxies[1] = { kind: 'unknown', name: 'B', type: 'vmess' };
      await app.reload(next);
      const after = app.outboundOf('🚀 节点选择');
      expect(after).not.toBe(before);
      const conn = await after!.connect({ ...target, host: `${type}-member.test` });
      await echo(conn, 'supported-node-only');
      expect(a.events.targets).toContain(`${type}-member.test:80`);
      conn.close();
    } finally { await app.stop(); }
  });
}
