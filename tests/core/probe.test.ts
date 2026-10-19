import { expect, test } from 'bun:test';
import { aggregateHealth, probeConnection } from '../../src/core/health.ts';
import type { Conn } from '../../src/core/types.ts';

function connection() {
  let closes = 0;
  let request = '';
  const conn: Conn = {
    closed: false,
    read: async (max) => { expect(max).toBe(128); return new TextEncoder().encode('HTTP/1.0 204\r\n\r\n'); },
    write: async (data) => { request = new TextDecoder().decode(data); return data.length; },
    close: () => { closes++; },
  };
  return { conn, closes: () => closes, request: () => request };
}

test('lightweight HEAD includes path/query/port and closes the probe stream on success', async () => {
  const c = connection();
  const delay = await probeConnection({ connect: async (target) => {
    expect(target).toEqual({ type: 'fqdn', host: 'example.test', port: 8080 });
    return c.conn;
  } }, 'http://example.test:8080/check?a=1', 100);
  expect(delay).toBeGreaterThanOrEqual(0);
  expect(c.request()).toBe('HEAD /check?a=1 HTTP/1.0\r\nHost: example.test:8080\r\n\r\n');
  expect(c.closes()).toBe(1);
  expect(aggregateHealth([{ at: 100, delayMs: 0 }])).toMatchObject({ alive: true, checkedAt: 100 });
});

test('probe deadline covers connect and closes a connection that arrives after timeout', async () => {
  const c = connection();
  let release: (conn: Conn) => void = () => {};
  const late = new Promise<Conn>((resolve) => { release = resolve; });
  const delay = await probeConnection({ connect: () => late }, 'http://example.test', 10);
  expect(delay).toBeNull();
  expect(c.closes()).toBe(0);
  release(c.conn);
  await Bun.sleep(0);
  expect(c.closes()).toBe(1);
  expect(c.request()).toBe('');
});

test('probe timeout, empty response and read/write errors all close the acquired stream', async () => {
  for (const mode of ['timeout', 'empty', 'read-error', 'write-error'] as const) {
    const c = connection();
    c.conn.read = async () => {
      if (mode === 'timeout') return new Promise<Uint8Array>(() => {});
      if (mode === 'read-error') throw new Error('injected');
      return new Uint8Array();
    };
    if (mode === 'write-error') c.conn.write = async () => { throw new Error('injected'); };
    expect(await probeConnection({ connect: async () => c.conn }, 'http://example.test', 10)).toBeNull();
    expect(c.closes()).toBe(1);
  }
});

test('invalid URL, oversized request, invalid deadline and connection errors return no sample value', async () => {
  let connects = 0;
  const outbound = { connect: async (): Promise<Conn> => { connects++; throw new Error('injected'); } };
  for (const url of ['invalid', 'https://example.test', `http://example.test/${'a'.repeat(2048)}`]) {
    expect(await probeConnection(outbound, url, 20)).toBeNull();
  }
  expect(await probeConnection(outbound, 'http://example.test', 0)).toBeNull();
  expect(connects).toBe(0);
  expect(await probeConnection(outbound, 'http://example.test', 20)).toBeNull();
  expect(connects).toBe(1);
});
