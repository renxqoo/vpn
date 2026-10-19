import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { App } from '../../src/app.ts';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';
import { SelectGroup } from '../../src/rules/groups.ts';
import { setLogLevel } from '../../src/core/log.ts';

let good: AnytlsTestServer;
let app: App;

beforeAll(async () => {
  setLogLevel('error');
  good = new AnytlsTestServer({ password: 'g' });
  await good.start();
  app = new App({
    config: {
      httpPort: 0,
      socksPort: 0,
      mode: 'rule',
      logLevel: 'info',
      apiAddr: '127.0.0.1:0',
      apiSecret: '',
      proxies: [
        { kind: 'unknown', name: 'legacy', type: 'ss' },
        {
          kind: 'anytls',
          name: 'good',
          server: '127.0.0.1',
          port: good.port,
          password: 'g',
          skipCertVerify: true,
          udp: false,
          idleSessionCheckIntervalSec: 30,
          idleSessionTimeoutSec: 30,
          minIdleSession: 5,
        },
        {
          kind: 'anytls',
          name: 'n2',
          server: '127.0.0.1',
          port: good.port,
          password: 'g',
          skipCertVerify: true,
          udp: false,
          idleSessionCheckIntervalSec: 30,
          idleSessionTimeoutSec: 30,
          minIdleSession: 5,
        },
      ],
      groups: [
        { name: 'A', type: 'select', proxies: ['legacy', 'good'] },
        { name: 'FWD', type: 'select', proxies: ['B-later', 'n2'] },
        { name: 'B-later', type: 'select', proxies: ['n2'] },
      ],
      rules: [{ type: 'MATCH', payload: '', target: 'A', noResolve: false, raw: 'MATCH,A' }],
      ruleProviders: new Map(),
    },
    cacheDir: '/tmp/group-mix-cache',
    overrides: {},
  });
  await app.start();
});
afterAll(async () => {
  await app.stop();
  good.stop();
});

describe('mixed-type and forward-referencing groups', () => {
  test('group with unavailable leading member still routes through the usable one', async () => {
    const group = app.outboundOf('A') as SelectGroup;
    expect(group).toBeDefined();
    expect(group.current()).toBe('good');
    expect(group.memberNames()).toContain('good');
    expect(group.memberNames()).not.toContain('legacy');
    const conn = await group.connect({ type: 'fqdn', host: 'x.test', port: 80 });
    await conn.write(new TextEncoder().encode('hi'));
    const echo = await conn.read(16);
    expect(new TextDecoder().decode(echo)).toBe('hi');
    conn.close();
  });

  test('forward group reference resolves after later declaration', () => {
    const fwd = app.outboundOf('FWD') as SelectGroup;
    expect(fwd).toBeDefined();
    expect(fwd.memberNames()).toContain('B-later');
    expect(fwd.select('B-later')).toBe(true);
    const b = app.outboundOf('B-later') as SelectGroup;
    expect(b?.current()).toBe('n2');
  });
});
