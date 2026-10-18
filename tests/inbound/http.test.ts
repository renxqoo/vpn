import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HttpInbound } from '../../src/inbound/http.ts';
import { DirectOutbound } from '../../src/outbound/direct.ts';
import type { Router } from '../../src/core/types.ts';

async function startEcho(): Promise<{ port: number; stop(): void }> {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
      open() {},
      close() {},
      error() {},
    },
  });
  return { port: listener.port, stop: () => listener.stop(true) };
}

async function connectRaw(port: number): Promise<{ sock: Bun.Socket<undefined>; next(): Promise<Uint8Array> }> {
  const chunks: Uint8Array[] = [];
  const waiters: ((d: Uint8Array) => void)[] = [];
  return Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, d) {
        const u = new Uint8Array(d);
        if (waiters.length > 0) {
          for (const w of waiters.splice(0)) w(u);
        } else {
          chunks.push(u);
        }
      },
      open() {},
      close() {},
      error() {},
    },
  }).then((sock) => ({
    sock,
    recv: [],
    next() {
      const existing = chunks.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push(resolve));
    },
  }));
}

const routerAll: Router = { resolve: () => ({ outbound: 'DIRECT' }) };
const routerReject: Router = { resolve: () => ({ reject: true }) };

let echoPort: number;
let echoStop: () => void;
beforeAll(async () => {
  const echo = await startEcho();
  echoPort = echo.port;
  echoStop = echo.stop;
});
afterAll(() => echoStop());

describe('http inbound', () => {
  test(
    'CONNECT tunnel established and payload echoed',
    async () => {
      const inbound = new HttpInbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
      const first = await cli.next();
      const text = new TextDecoder().decode(first);
      expect(text.startsWith('HTTP/1.1 200')).toBe(true);
      // 200 响应头之后的同一包里可能带 echo 数据；发 payload 收回显
      cli.sock.write('ping-http');
      const echoed: Uint8Array[] = [first.subarray(text.indexOf('\r\n\r\n') + 4)];
      const want = 'ping-http';
      for (let i = 0; i < 5 && new TextDecoder().decode(concat(echoed)) !== want; i++) {
        echoed.push(await cli.next());
      }
      expect(new TextDecoder().decode(concat(echoed))).toBe(want);
      cli.sock.end();
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'CONNECT rejected by rule → 403',
    async () => {
      const inbound = new HttpInbound({ port: 0, router: routerReject, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(`CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n`);
      const first = new TextDecoder().decode(await cli.next());
      expect(first.startsWith('HTTP/1.1 403')).toBe(true);
      expect(first).toContain('blocked by rule');
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'absolute-form GET forwarded with origin request-line',
    async () => {
      const inbound = new HttpInbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      const req = `GET http://127.0.0.1:${echoPort}/path?q=1 HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${echoPort}\r\nConnection: close\r\n\r\n`;
      cli.sock.write(req);
      // 回显服务器会把收到的请求原样回来（含重写后的 request-line）
      const acc: Uint8Array[] = [];
      for (let i = 0; i < 8; i++) {
        const c = await cli.next();
        acc.push(c);
        const t = new TextDecoder().decode(concat(acc));
        if (t.includes('GET /path?q=1 HTTP/1.1')) break;
      }
      const t = new TextDecoder().decode(concat(acc));
      expect(t).toContain('GET /path?q=1 HTTP/1.1');
      expect(t).not.toContain('http://127.0.0.1');
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'upstream unreachable → 502',
    async () => {
      const inbound = new HttpInbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n');
      const first = new TextDecoder().decode(await cli.next());
      expect(first.startsWith('HTTP/1.1 502')).toBe(true);
      inbound.stop();
    },
    { timeout: 8000 },
  );
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
