import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AnytlsClient } from '../../src/outbound/anytls/client.ts';
import { EofError } from '../../src/outbound/anytls/session.ts';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';

const PASSWORD = 'test-password-123';

let server: AnytlsTestServer;

beforeAll(async () => {
  server = new AnytlsTestServer({ password: PASSWORD });
  await server.start();
});

afterAll(() => {
  server.stop();
});

function makeClient(): AnytlsClient {
  return new AnytlsClient('test-node', {
    host: '127.0.0.1',
    port: server.port,
    password: PASSWORD,
    skipCertVerify: true,
    clientName: 'bunclash-test/1.0.0',
    idleSessionCheckIntervalMs: 60000,
    idleSessionTimeoutMs: 60000,
  });
}

describe('write path honesty (dead-session writes must not report success)', () => {
  test(
    'writeStreamData rejects when session dies before dequeue',
    async () => {
      const server = new AnytlsTestServer({ password: 'wp' });
      await server.start();
      const client = new AnytlsClient('honesty', {
        host: '127.0.0.1',
        port: server.port,
        password: 'wp',
        skipCertVerify: true,
        clientName: 'honesty-test',
        idleSessionCheckIntervalMs: 60000,
        idleSessionTimeoutMs: 60000,
      });
      const { stream, done } = await client.openStream();
      await stream.writeTarget({ type: 'fqdn', host: 'x.test', port: 80 });
      // 大块写走 padding 多步；写进行中击杀会话 → 写必须 reject（不能谎报成功）
      const sess = (client as unknown as { sessions: Map<number, { die(r: string): void }> }).sessions;
      const first = [...sess.values()][0];
      const payload = new Uint8Array(1024 * 1024).fill(65);
      const writePromise = stream.write(payload);
      first?.die('socket closed');
      await expect(writePromise).rejects.toThrow();
      stream.close();
      await done;
      client.close();
      server.stop();
    },
    { timeout: 10000 },
  );
});

describe('anytls client ↔ test server', () => {
  test(
    'echo roundtrip through stream',
    async () => {
      const client = makeClient();
      const { stream, done } = await client.openStream();
      await stream.writeTarget({ type: 'fqdn', host: 'example.com', port: 80 });
      const payload = new TextEncoder().encode('hello anytls');
      await stream.write(payload);
      const got = await stream.read(4096);
      expect(new TextDecoder().decode(got)).toBe('hello anytls');
      stream.close();
      await done;
      expect(server.events.targets[0]).toBe('example.com:80');
      client.close();
    },
    { timeout: 10000 },
  );

  test(
    'session reuse: finished stream returns session to pool for next stream',
    async () => {
      const client = makeClient();
      const a = await client.openStream();
      await a.stream.writeTarget({ type: 'fqdn', host: 'a.example', port: 1 });
      expect(client.activeSessionCount()).toBe(1);
      await a.stream.write(new TextEncoder().encode('AAA'));
      const ra = new TextDecoder().decode(await a.stream.read(16));
      expect(ra).toBe('AAA');
      a.stream.close();
      await a.done;
      // 流 A 结束后会话回池：空闲 1
      expect(client.idleSessionCount()).toBe(1);
      // 下一条流应复用同一会话（seq 最大）
      const b = await client.openStream();
      await b.stream.writeTarget({ type: 'fqdn', host: 'b.example', port: 2 });
      expect(client.activeSessionCount()).toBe(1);
      await b.stream.write(new TextEncoder().encode('BBB'));
      const rb = new TextDecoder().decode(await b.stream.read(16));
      expect(rb).toBe('BBB');
      b.stream.close();
      await b.done;
      client.close();
    },
    { timeout: 10000 },
  );

  test(
    'remote fin: server closes stream (fin) → client read gets EOF',
    async () => {
      const client = makeClient();
      const { stream, done } = await client.openStream();
      await stream.writeTarget({ type: 'ipv4', host: '10.0.0.9', port: 9 });
      stream.close(); // 本端关闭触发 FIN；读端应 EOF
      await done;
      await expect(stream.read(16)).rejects.toBeInstanceOf(EofError);
      client.close();
    },
    { timeout: 10000 },
  );

  test(
    'wrong password: server rejects (alert + close)',
    async () => {
      const bad = new AnytlsClient('bad', {
        host: '127.0.0.1',
        port: server.port,
        password: 'wrong-password',
        skipCertVerify: true,
        clientName: 'bunclash-test/1.0.0',
      });
      const { stream } = await bad.openStream();
      await stream.writeTarget({ type: 'fqdn', host: 'x.example', port: 1 });
      await expect(stream.read(64)).rejects.toBeTruthy();
      expect(server.events.authFailures).toBeGreaterThan(0);
      bad.close();
    },
    { timeout: 10000 },
  );

  test(
    'large payload split across frames (100KB)',
    async () => {
      const client = makeClient();
      const { stream, done } = await client.openStream();
      await stream.writeTarget({ type: 'fqdn', host: 'big.example', port: 80 });
      const payload = new Uint8Array(100 * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      await stream.write(payload);
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (received < payload.length) {
        try {
          const c = await stream.read(65536);
          chunks.push(c);
          received += c.length;
        } catch (_e) {
          break;
        }
      }
      const merged = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      expect(merged.length).toBe(payload.length);
      expect(merged.every((b, i) => b === payload[i])).toBe(true);
      stream.close();
      await done;
      client.close();
    },
    { timeout: 15000 },
  );

  test(
    'concurrent streams keep data isolated',
    async () => {
      const client = makeClient();
      const streams = await Promise.all(
        Array.from({ length: 5 }, (_, i) => client.openStream().then(async (s) => {
          await s.stream.writeTarget({ type: 'fqdn', host: `iso-${i}.example`, port: 80 });
          return s;
        })),
      );
      await Promise.all(
        streams.map(async (s, i) => {
          await s.stream.write(new TextEncoder().encode(`payload-${i}`));
        }),
      );
      const results = await Promise.all(
        streams.map((s) => s.stream.read(64).then((d) => new TextDecoder().decode(d))),
      );
      for (let i = 0; i < 5; i++) expect(results[i]).toBe(`payload-${i}`);
      for (const s of streams) s.stream.close();
      await Promise.all(streams.map((s) => s.done));
      client.close();
    },
    { timeout: 15000 },
  );
});

test('closing a client during TLS connection cannot publish a late session or stream', async () => {
  const client = makeClient();
  const opening = client.openStream();
  // openStream 已进入 createSession，close 必须覆盖尚未加入会话池的连接。
  client.close();
  await expect(opening).rejects.toThrow('client closed');
  await Bun.sleep(30);
  expect(client.activeSessionCount()).toBe(0);
  expect(client.idleSessionCount()).toBe(0);
  await expect(client.openStream()).rejects.toThrow('client closed');
});

test('client close reclaims a late TCP socket even when the peer never completes TLS', async () => {
  let accepted = 0;
  let closed = 0;
  const hanging = Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open() { accepted++; },
      data() {},
      close() { closed++; },
    },
  });
  const client = new AnytlsClient('hanging-handshake', {
    host: '127.0.0.1', port: hanging.port, password: 'pw', skipCertVerify: true, clientName: 'test',
  });
  try {
    const opening = client.openStream();
    client.close();
    await expect(opening).rejects.toThrow('client closed');
    for (let i = 0; i < 100 && (accepted === 0 || closed !== accepted); i++) await Bun.sleep(5);
    expect(accepted).toBe(1);
    expect(closed).toBe(accepted);
    expect(client.activeSessionCount()).toBe(0);
  } finally {
    client.close();
    hanging.stop(true);
  }
});
