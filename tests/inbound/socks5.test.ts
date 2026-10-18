import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Socks5Inbound } from '../../src/inbound/socks5.ts';
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

interface RawClient {
  sock: Bun.Socket<undefined>;
  next(): Promise<Uint8Array>;
}

async function connectRaw(port: number): Promise<RawClient> {
  const chunks: Uint8Array[] = [];
  const waiters: ((d: Uint8Array) => void)[] = [];
  const sock = await Bun.connect({
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
  });
  return {
    sock,
    next() {
      const existing = chunks.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const routerAll: Router = { resolve: () => ({ outbound: 'DIRECT' }) };

let echoPort: number;
let stopEcho: () => void;
beforeAll(async () => {
  const echo = await startEcho();
  echoPort = echo.port;
  stopEcho = echo.stop;
});
afterAll(() => stopEcho());

describe('socks5 inbound', () => {
  test(
    'no-auth CONNECT fqdn echoes payload',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5, 1, 0])); // greeting: no-auth
      const greeting = await cli.next();
      expect(Array.from(greeting)).toEqual([5, 0]);
      // request: CONNECT fqdn 127.0.0.1 → 用 ipv4 atyp
      const req = new Uint8Array([5, 1, 0, 1, 127, 0, 0, 1, echoPort >> 8, echoPort & 0xff]);
      cli.sock.write(req);
      const reply = await cli.next();
      expect(reply[1]).toBe(0); // succeeded
      cli.sock.write(new TextEncoder().encode('ping-socks'));
      // 响应与回显可能同包粘连：累积到收到完整回显为止
      const acc: Uint8Array[] = [reply.subarray(10)];
      for (let i = 0; i < 6; i++) {
        const joined = new TextDecoder().decode(concatAll(acc));
        if (joined.includes('ping-socks')) break;
        acc.push(await cli.next());
      }
      expect(new TextDecoder().decode(concatAll(acc))).toContain('ping-socks');
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'CONNECT with fqdn target',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5, 1, 0]));
      await cli.next();
      const name = new TextEncoder().encode('localhost');
      const req = new Uint8Array([5, 1, 0, 3, name.length, ...name, echoPort >> 8, echoPort & 0xff]);
      cli.sock.write(req);
      const reply = await cli.next();
      expect(reply[1]).toBe(0);
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'unsupported auth method → 0xff',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5, 1, 2])); // 只提供 method 2
      const resp = await cli.next();
      expect(Array.from(resp)).toEqual([5, 0xff]);
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'UDP ASSOCIATE → REP 0x07',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5, 1, 0]));
      await cli.next();
      cli.sock.write(new Uint8Array([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])); // cmd=3 UDP
      const reply = await cli.next();
      expect(reply[1]).toBe(7);
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'malformed atyp 0x99 → fail and close',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5, 1, 0]));
      await cli.next();
      cli.sock.write(new Uint8Array([5, 1, 0, 0x99, 0, 0, 0, 0, 0, 0]));
      const reply = await cli.next();
      expect(reply[1]).toBe(1); // general SOCKS failure
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'upstream unreachable → REP 0x01',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5, 1, 0]));
      await cli.next();
      cli.sock.write(new Uint8Array([5, 1, 0, 1, 127, 0, 0, 1, 0, 1])); // port 1
      const reply = await cli.next();
      expect(reply[1]).toBe(1);
      inbound.stop();
    },
    { timeout: 8000 },
  );

  test(
    'split greeting bytes across packets (slow loris shape)',
    async () => {
      const inbound = new Socks5Inbound({ port: 0, router: routerAll, outboundOf: () => new DirectOutbound() });
      await inbound.start();
      const cli = await connectRaw(inbound.port);
      cli.sock.write(new Uint8Array([5]));
      await new Promise((r) => setTimeout(r, 30));
      cli.sock.write(new Uint8Array([1]));
      await new Promise((r) => setTimeout(r, 30));
      cli.sock.write(new Uint8Array([0]));
      const greeting = await cli.next();
      expect(Array.from(greeting)).toEqual([5, 0]);
      inbound.stop();
    },
    { timeout: 8000 },
  );
});

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
