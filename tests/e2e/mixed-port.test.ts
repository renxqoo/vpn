import { expect, test } from 'bun:test';
import { App } from '../../src/app.ts';
import { buildRuntimeConfig } from '../../src/config/settings.ts';

/** e2e：mixed-port 在 App 装配层（真实 Direct 出站 + echo 目标） */

function startEcho(): Promise<{ port: number; stop(): void; received(): string[] }> {
  return new Promise((resolve) => {
    const received: string[] = [];
    const listener = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: {
        data(socket, chunk) {
          const text = new TextDecoder().decode(chunk as Buffer);
          if (!text.includes('HTTP/1.1')) received.push(text);
          socket.write(chunk as Buffer);
        },
      },
    });
    resolve({ port: listener.port, stop: () => listener.stop(true), received: () => received });
  });
}

test('mixed port serves HTTP and SOCKS5 on one listener; getters agree', async () => {
  const echo = await startEcho();
  const runtime = await buildRuntimeConfig({
    files: { homeConfigText: '', dotenvText: null }, subscriptionYaml: null,
  });
  const app = new App({
    config: runtime.config,
    cacheDir: '/tmp/bunclash-mixed-e2e',
    overrides: { ...runtime.overrides, mixedPort: 0, httpPort: 0, socksPort: 0, apiPort: 0 },
  });
  try {
    await app.start();
    const port = app.mixedPortForTest;
    expect(port).toBeGreaterThan(0);
    expect(app.httpPort).toBe(port);
    expect(app.socksPortForTest).toBe(port);

    // SOCKS5 全旅程（CONNECT echo + 数据往返）
    const chunks: Uint8Array[] = [];
  const waiters: ((d: Uint8Array) => void)[] = [];
  const sock = await Bun.connect({
    hostname: '127.0.0.1', port,
    socket: {
      data(_s, d) {
        const u = new Uint8Array(d);
        if (waiters.length > 0) { for (const w of waiters.splice(0)) w(u); } else { chunks.push(u); }
      },
      close() {}, error() {},
    },
  });
  const next = (): Promise<Uint8Array> => {
    const existing = chunks.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push(resolve));
  };
  sock.write(new Uint8Array([5, 1, 0]));
  const greet = await next();
  expect([greet[0], greet[1]]).toEqual([5, 0]);
  const host = new TextEncoder().encode('127.0.0.1');
  sock.write(new Uint8Array([5, 1, 0, 3, host.length, ...host, (echo.port >> 8) & 0xff, echo.port & 0xff]));
  const rep = await next();
  expect(rep[1]).toBe(0);
  sock.write(new TextEncoder().encode('mixed-e2e'));
  const echoed = new TextDecoder().decode(await next());
  expect(echoed).toBe('mixed-e2e');
  sock.end();

  // HTTP CONNECT 隧道全旅程
  const c2 = await Bun.connect({
    hostname: '127.0.0.1', port,
    socket: { data(_s, d) {
      const u = new Uint8Array(d);
      if (waiters.length > 0) { for (const w of waiters.splice(0)) w(u); } else { chunks.push(u); }
    }, close() {}, error() {} },
  });
  c2.write(new TextEncoder().encode(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`));
  const conn = new TextDecoder().decode(await next());
  expect(conn).toContain('200');
  c2.write(new TextEncoder().encode('via-connect'));
  const echoed2 = new TextDecoder().decode(await next());
  expect(echoed2).toBe('via-connect');
  c2.end();
  } finally {
    await app.stop();
    echo.stop();
  }
}, 15_000);

test('no mixedPort: legacy dual listeners unchanged (regression)', async () => {
  const runtime = await buildRuntimeConfig({
    files: { homeConfigText: '', dotenvText: null }, subscriptionYaml: null,
  });
  const app = new App({
    config: runtime.config,
    cacheDir: '/tmp/bunclash-mixed-reg',
    overrides: { httpPort: 0, socksPort: 0, apiPort: 0 },
  });
  try {
    await app.start();
    expect(app.mixedPortForTest).toBe(0);
    expect(app.httpPort).toBeGreaterThan(0);
    expect(app.socksPortForTest).toBeGreaterThan(0);
    expect(app.httpPort).not.toBe(app.socksPortForTest);
  } finally {
    await app.stop();
  }
}, 15_000);
