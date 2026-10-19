import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Socks5Inbound } from '../../src/inbound/socks5.ts';
import { DirectOutbound } from '../../src/outbound/direct.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { setLogLevel } from '../../src/core/log.ts';

function echoServer(): Bun.TCPSocketListener<undefined> {
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s, d) {
        s.write(d);
      },
      open() {},
      close() {},
      error() {},
    },
  });
}

let echo: Bun.TCPSocketListener<undefined>;
let inbound: Socks5Inbound;
const tracker = new ConnectionTracker();
const direct = new DirectOutbound();

beforeAll(async () => {
  setLogLevel('error');
  echo = echoServer();
  inbound = new Socks5Inbound({
    port: 0,
    router: { resolve: () => ({ outbound: 'DIRECT' }) },
    outboundOf: (n) => (n === 'DIRECT' ? direct : undefined),
    onOpen: (info) => {
      tracker.open({
        id: info.id,
        protocol: 'socks5',
        host: info.host,
        destinationIP: '',
        port: info.port,
        chains: info.chain,
        start: Date.now(),
        meter: info.meter,
        close: info.close,
      });
    },
    onClose: (id) => {
      tracker.close(id);
    },
  });
  await inbound.start();
});
afterAll(() => {
  inbound.stop();
  echo.stop(true);
});

describe('socks5 early data metering', () => {
  test(
    'payload sent right after CONNECT reply is counted as upload',
    async () => {
      const chunks: Uint8Array[] = [];
      const sock = await Bun.connect({
        hostname: '127.0.0.1',
        port: inbound.port,
        socket: {
          data(_s, d) {
            chunks.push(new Uint8Array(d));
          },
          open(s) {
            s.write(new Uint8Array([5, 1, 0]));
          },
          close() {},
          error() {},
        },
      });
      await new Promise((r) => setTimeout(r, 150));
      sock.write(new Uint8Array([5, 1, 0, 1, 127, 0, 0, 1, (echo.port >> 8) & 0xff, echo.port & 0xff]));
      await new Promise((r) => setTimeout(r, 250));
      const early = new TextEncoder().encode('E'.repeat(5000));
      sock.write(early);
      await new Promise((r) => setTimeout(r, 700));
      sock.end();
      const live = tracker.snapshot();
      const total = live.reduce((n, c) => n + c.meter.uploaded(), 0) + 5000 * 0;
      const echoed = chunks.reduce((n, c) => n + c.length, 0);
      expect(echoed).toBeGreaterThanOrEqual(10 + 5000);
      expect(total).toBeGreaterThanOrEqual(5000);
    },
    { timeout: 15000 },
  );
});
