/**
 * e2e 旅程（design.md §3.3）：本地 AnyTLS 测试服务端 A/B + 内核全链路。
 * 1. HTTP CONNECT 命中 A 规则 → 走 A；2. 未命中 → MATCH 走 B；
 * 3. API 切换 select 组 → 新连接走 B；4. SOCKS5 全链路；5. 台账与规则视图。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { App } from '../../src/app.ts';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';
import type { ClashConfig } from '../../src/config/clash.ts';

let serverA: AnytlsTestServer;
let serverB: AnytlsTestServer;
let app: App;

const CONFIG = (): ClashConfig => ({
  httpPort: 0,
  socksPort: 0,
  mode: 'rule',
  logLevel: 'silent',
  apiAddr: '127.0.0.1:0',
  apiSecret: '',
  proxies: [],
  groups: [
    { name: '选择', type: 'select', proxies: ['A', 'B'] },
  ],
  rules: [
    { type: 'DOMAIN-SUFFIX', payload: 'alpha.test', target: 'A', noResolve: false, raw: '' },
    { type: 'MATCH', payload: '', target: '选择', noResolve: false, raw: '' },
  ],
  ruleProviders: new Map(),
});

beforeAll(async () => {
  serverA = new AnytlsTestServer({ password: 'pw-a' });
  serverB = new AnytlsTestServer({ password: 'pw-b' });
  await serverA.start();
  await serverB.start();
  const config = CONFIG();
  config.proxies = [
    {
      kind: 'anytls',
      name: 'A',
      server: '127.0.0.1',
      port: serverA.port,
      password: 'pw-a',
      skipCertVerify: true,
      udp: false,
      idleSessionCheckIntervalSec: 30,
      idleSessionTimeoutSec: 30,
      minIdleSession: 5,
    },
    {
      kind: 'anytls',
      name: 'B',
      server: '127.0.0.1',
      port: serverB.port,
      password: 'pw-b',
      skipCertVerify: true,
      udp: false,
      idleSessionCheckIntervalSec: 30,
      idleSessionTimeoutSec: 30,
      minIdleSession: 5,
    },
  ];
  app = new App({ config, cacheDir: '/tmp/bunclash-e2e-cache' });
  await app.start();
  void app; // ports asserted via tests below
});

afterAll(async () => {
  await app.stop();
  serverA.stop();
  serverB.stop();
});

async function connectViaTunnel(
  port: number,
  host: string,
  connPort: number,
): Promise<{ send(data: string): void; recvAll(timeoutMs: number): Promise<string> }> {
  const chunks: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  let headerBuf = '';
  let headerDone = false;
  const deliver = (t: string) => {
    if (waiters.length > 0) for (const w of waiters.splice(0)) w(t);
    else chunks.push(t);
  };
  const sock = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, d) {
        const t = new TextDecoder().decode(d);
        if (!headerDone) {
          headerBuf += t;
          const idx = headerBuf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          headerDone = true;
          const rest = headerBuf.slice(idx + 4);
          if (rest) deliver(rest);
          return;
        }
        deliver(t);
      },
      open() {},
      close() {},
      error() {},
    },
  });
  sock.write(`CONNECT ${host}:${connPort} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tunnel header timeout')), 8000);
    const check = () => {
      if (headerDone) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
  return {
    send(data: string) {
      sock.write(data);
    },
    recvAll(timeoutMs: number) {
      if (chunks.length > 0) return Promise.resolve(chunks.splice(0).join(''));
      return new Promise((res) => {
        waiters.push((x) => res(x));
        setTimeout(() => res(''), timeoutMs);
      });
    },
  };
}

describe('e2e: http inbound → rules → anytls → test servers', () => {
  test(
    'alpha.test domain hits rule → server A; other → group(select A) → A',
    async () => {
      const t1 = await connectViaTunnel(app.httpPort, 'x.alpha.test', 80);
      t1.send('ping-a');
      const echo = await t1.recvAll(5000);
      expect(echo).toBe('ping-a');
      expect(serverA.events.targets.some((t) => t === 'x.alpha.test:80')).toBe(true);
    },
    { timeout: 15000 },
  );

  test(
    'beta.test (MATCH→选择组，默认 A) also goes through A',
    async () => {
      const t = await connectViaTunnel(app.httpPort, 'y.beta.test', 443);
      t.send('ping-b');
      const echo = await t.recvAll(5000);
      expect(echo).toBe('ping-b');
      expect(serverA.events.targets.some((x) => x === 'y.beta.test:443')).toBe(true);
    },
    { timeout: 15000 },
  );

  test(
    'api: switch selector to B → subsequent traffic hits B',
    async () => {
      const res = await fetch(`http://127.0.0.1:${app.apiPortForTest}/proxies/${encodeURIComponent('选择')}`, {
        method: 'PUT',
        body: JSON.stringify({ now: 'B' }),
      });
      expect(res.status).toBe(204);
      const t = await connectViaTunnel(app.httpPort, 'z.gamma.test', 80);
      t.send('after-switch');
      const echo = await t.recvAll(5000);
      expect(echo).toBe('after-switch');
      expect(serverB.events.targets.some((x) => x === 'z.gamma.test:80')).toBe(true);
    },
    { timeout: 15000 },
  );

  test(
    'socks5 inbound full chain via group',
    async () => {
      // 组当前已切到 B（上一用例）；SOCKS5 走 B
      const chunks: string[] = [];
      const sock = await Bun.connect({
        hostname: '127.0.0.1',
        port: app.socksPortForTest,
        socket: {
          data(_s, d) {
            chunks.push(new TextDecoder().decode(d));
          },
          open() {},
          close() {},
          error() {},
        },
      });
      sock.write(new Uint8Array([5, 1, 0]));
      await new Promise((r) => setTimeout(r, 100));
      const name = new TextEncoder().encode('socks.e2e.test');
      const req = new Uint8Array([5, 1, 0, 3, name.length, ...name, 0, 80]);
      sock.write(req);
      await new Promise((r) => setTimeout(r, 200));
      sock.write('socks-payload');
      let got = '';
      for (let i = 0; i < 10 && !got.includes('socks-payload'); i++) {
        got = chunks.splice(0).join('');
        if (!got) await new Promise((r) => setTimeout(r, 200));
      }
      expect(got).toContain('socks-payload');
      expect(serverB.events.targets.some((t) => t === 'socks.e2e.test:80')).toBe(true);
      sock.end();
    },
    { timeout: 15000 },
  );

  test(
    'connection metering reports real byte counts',
    async () => {
      const t = await connectViaTunnel(app.httpPort, 'metering.test', 80);
      const payload = 'x'.repeat(4096);
      t.send(payload);
      const echo = await t.recvAll(5000);
      expect(echo).toBe(payload);
      const res = await fetch(`http://127.0.0.1:${app.apiPortForTest}/connections`);
      const j = await res.json() as {
        connections: {
          metadata: { host: string };
          upload: number;
          download: number;
          upRate: number;
          downRate: number;
        }[];
      };
      const conn = j.connections.find((c) => c.metadata.host === 'metering.test');
      expect(conn).toBeDefined();
      expect(conn?.upload).toBeGreaterThanOrEqual(4096);
      expect(conn?.download).toBeGreaterThanOrEqual(4096);
    },
    { timeout: 15000 },
  );

  test(
    'rules endpoint exposes the chain',
    async () => {
      const res = await fetch(`http://127.0.0.1:${app.apiPortForTest}/rules`);
      expect(res.ok).toBe(true);
      const j = (await res.json()) as { rules: { type: string; payload: string; target: string }[] };
      expect(j.rules.length).toBe(2);
      expect(j.rules[0]?.type).toBe('DOMAIN-SUFFIX');
      expect(j.rules[1]?.target).toBe('选择');
    },
    { timeout: 10000 },
  );
});
