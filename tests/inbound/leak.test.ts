import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HttpInbound } from '../../src/inbound/http.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { DirectOutbound } from '../../src/outbound/direct.ts';
import { setLogLevel } from '../../src/core/log.ts';

function lengthOrigin(): Bun.TCPSocketListener<undefined> {
  return Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket: Bun.Socket<undefined>, data: Buffer) {
        const text = new TextDecoder().decode(data);
        if (!text.includes('\r\n\r\n')) return;
        const body = `origin-payload-${Date.now() % 100000}`;
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        socket.end();
      },
      open() {},
      close() {},
      error() {},
    },
  });
}

let origin: ReturnType<typeof lengthOrigin>;
let inbound: HttpInbound;
let closedCount = 0;
const direct = new DirectOutbound();
const tracker = new ConnectionTracker();

beforeAll(async () => {
  setLogLevel('error');
  origin = lengthOrigin();
  inbound = new HttpInbound({
    port: 0,
    router: { resolve: () => ({ outbound: 'DIRECT' }) },
    outboundOf: (n) => (n === 'DIRECT' ? direct : undefined),
    onOpen: (info) => {
      tracker.open({
        id: info.id,
        protocol: 'http',
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
      closedCount++;
      tracker.close(id);
    },
  });
  await inbound.start();
});
afterAll(() => {
  inbound.stop();
  origin.stop(true);
});

describe('absolute-form forwarding lifecycle', () => {
  test(
    'Content-Length responses release upstream and tracker entries promptly',
    async () => {
      const before = closedCount;
      void before;
      for (let i = 0; i < 10; i++) {
        const sock = await Bun.connect({
          hostname: '127.0.0.1',
          port: inbound.port,
          socket: {
            data(_s, d) {
              void d;
            },
            open(s) {
              s.write(
                `GET http://127.0.0.1:${origin.port}/ HTTP/1.1\r\n` +
                  `Host: 127.0.0.1:${origin.port}\r\nConnection: close\r\n\r\n`,
              );
            },
            close() {},
            error() {},
          },
        });
        await new Promise((r) => setTimeout(r, 100));
        sock.end();
      }
      await new Promise((r) => setTimeout(r, 500));
      expect(tracker.snapshot().length).toBe(0);
      expect(closedCount).toBeGreaterThanOrEqual(10);
    },
    { timeout: 20000 },
  );
});
