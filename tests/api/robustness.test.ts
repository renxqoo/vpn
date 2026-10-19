import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RestApi } from '../../src/api/server.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { RuleEngine } from '../../src/rules/index.ts';
import { parseRuleLine } from '../../src/config/clash.ts';

let api: RestApi;
const engine = new RuleEngine({
  rules: [parseRuleLine('MATCH,DIRECT')],
  providers: new Map(),
  geoip: null,
  final: 'DIRECT',
});

beforeAll(async () => {
  api = new RestApi({
    tracker: new ConnectionTracker(),
    loopbackPort: 0,
    outboundOf: () => undefined,
    outboundNames: () => [],
    engine,
    secret: '',
    setMode: () => true,
    currentMode: () => 'rule',
  });
  await api.start('127.0.0.1:0');
});
afterAll(() => api.stop());

async function rawGet(path: string): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    let buf = '';
    void Bun.connect({
      hostname: '127.0.0.1',
      port: api.port,
      socket: {
        data(_s, d) {
          buf += new TextDecoder().decode(d);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx >= 0) {
            resolve({ status: Number((buf.split(' ')[1] as string) ?? 0), head: buf.slice(0, idx) });
          }
        },
        open(sock) {
          sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${api.port}\r\n\r\n`);
        },
        close() {
          resolve({ status: Number((buf.split(' ')[1] as string) ?? 0), head: buf });
        },
        error(_s, e) {
          reject(new Error(String(e)));
        },
      },
    });
    setTimeout(() => reject(new Error('raw get timeout')), 3000);
  });
}

describe('api robustness against malformed input', () => {
  test(
    'malformed percent-encoding in path returns 400, process survives',
    async () => {
      const r = await rawGet('/proxies/%zz');
      expect(r.status).toBe(400);
      const alive = await fetch(`http://127.0.0.1:${api.port}/version`);
      expect(alive.ok).toBe(true);
    },
    { timeout: 8000 },
  );

  test(
    'non-local Host header is rejected (DNS rebinding guard)',
    async () => {
      const r = await new Promise<{ status: number }>((resolve, reject) => {
        let buf = '';
        void Bun.connect({
          hostname: '127.0.0.1',
          port: api.port,
          socket: {
            data(_s, d) {
              buf += new TextDecoder().decode(d);
              if (buf.includes('\r\n')) resolve({ status: Number(buf.split(' ')[1] as string) });
            },
            open(sock) {
              sock.write(`GET /version HTTP/1.1\r\nHost: evil.example.com\r\n\r\n`);
            },
            close() {
              resolve({ status: Number(buf.split(' ')[1] as string) });
            },
            error(_s, e) {
              reject(new Error(String(e)));
            },
          },
        });
        setTimeout(() => reject(new Error('timeout')), 3000);
      });
      expect(r.status).toBe(403);
    },
    { timeout: 8000 },
  );

  test(
    'localhost Host header is accepted',
    async () => {
      const r = await rawGet('/version');
      expect(r.status).toBe(200);
    },
    { timeout: 8000 },
  );
});
