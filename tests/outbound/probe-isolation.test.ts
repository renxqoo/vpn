import { expect, test } from 'bun:test';
import { AnytlsClient } from '../../src/outbound/anytls/client.ts';
import { AnytlsOutbound } from '../../src/outbound/anytls/index.ts';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';

test('latency probe leaves an existing transfer connection open and reclaims its separate client', async () => {
  const server = new AnytlsTestServer({ password: 'probe' });
  await server.start();
  const client = new AnytlsClient('node', {
    host: '127.0.0.1', port: server.port, password: 'probe', skipCertVerify: true, clientName: 'test',
  });
  const outbound = new AnytlsOutbound('node', client);
  const conn = await outbound.connect({ type: 'fqdn', host: 'normal.test', port: 443 });
  try {
    await conn.write(new TextEncoder().encode('before'));
    expect(new TextDecoder().decode(await conn.read())).toBe('before');
    expect(await outbound.probe('http://example.test/', 1000, { isolated: true })).not.toBeNull();
    expect(client.activeSessionCount()).toBe(1);
    expect(outbound.health()).toMatchObject({ alive: true, samples: 1 });
    await conn.write(new TextEncoder().encode('after'));
    expect(new TextDecoder().decode(await conn.read())).toBe('after');
    expect(conn.closed).toBe(false);
  } finally { conn.close(); outbound.close(); server.stop(); }
});

test('latency probe cancels its isolated client when TLS handshake stalls', async () => {
  let accepted = 0;
  let closed = 0;
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0,
    socket: { open() { accepted++; }, data() {}, close() { closed++; } } });
  const client = new AnytlsClient('stalled', {
    host: '127.0.0.1', port: listener.port, password: 'probe', skipCertVerify: true, clientName: 'test',
  });
  const outbound = new AnytlsOutbound('stalled', client);
  try {
    expect(await outbound.probe('http://example.test/', 50, { isolated: true })).toBeNull();
    const deadline = Date.now() + 1000;
    while (closed < accepted && Date.now() < deadline) await Bun.sleep(5);
    expect(accepted).toBe(1);
    expect(closed).toBe(1);
    expect(outbound.health()).toMatchObject({ alive: false, samples: 1 });
  } finally { outbound.close(); listener.stop(true); }
}, { timeout: 3000 });
