import { expect, test } from 'bun:test';
import { RestApi, type ApiDeps } from '../../src/api/server.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { RuleEngine } from '../../src/rules/index.ts';

function createApi(hooks: Partial<ApiDeps> = {}) {
  return new RestApi({
    tracker: new ConnectionTracker(), loopbackPort: 0,
    outboundOf: () => undefined, outboundNames: () => [],
    engine: new RuleEngine({ rules: [], providers: new Map(), geoip: null, final: 'DIRECT' }),
    secret: 'lifecycle-secret', setMode: () => true, currentMode: () => 'rule', ...hooks,
  });
}
const headers = { authorization: 'Bearer lifecycle-secret' };

test('system proxy and shutdown endpoints enforce Host/secret and report absent capabilities', async () => {
  const api = createApi();
  await api.start('127.0.0.1:0');
  const base = `http://127.0.0.1:${api.port}`;
  try {
    for (const path of ['/system-proxy/off', '/shutdown']) {
      expect((await fetch(base + path, { method: 'POST' })).status).toBe(401);
      expect((await fetch(base + path, { method: 'POST', headers: { ...headers, host: 'external.test' } })).status)
        .toBe(403);
      expect((await fetch(base + path, { method: 'POST', headers })).status).toBe(501);
    }
  } finally { api.stop(); }
});

test('proxy off keeps API alive and reports restore failure without claiming success', async () => {
  let fail = true;
  let calls = 0;
  const api = createApi({ disableSystemProxy: async () => {
    calls++;
    if (fail) throw new Error('private snapshot details');
  } });
  await api.start('127.0.0.1:0');
  const base = `http://127.0.0.1:${api.port}`;
  try {
    const failed = await fetch(`${base}/system-proxy/off`, { method: 'POST', headers });
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('private snapshot');
    fail = false;
    expect((await fetch(`${base}/system-proxy/off`, { method: 'POST', headers })).status).toBe(204);
    expect((await fetch(`${base}/version`, { headers })).status).toBe(200);
    expect(calls).toBe(2);
  } finally { api.stop(); }
});

test('shutdown restores first, replies before exit, retries failures and blocks reload', async () => {
  let fail = true;
  const events: string[] = [];
  const api = createApi({
    prepareShutdown: async () => { events.push('prepare'); if (fail) throw new Error('denied'); },
    shutdown: async () => { events.push('shutdown'); },
    reloadConfig: async () => { events.push('reload'); },
  });
  await api.start('127.0.0.1:0');
  const base = `http://127.0.0.1:${api.port}`;
  try {
    expect((await fetch(`${base}/shutdown`, { method: 'POST', headers })).status).toBe(400);
    expect(events).toEqual(['prepare']);
    expect((await fetch(`${base}/version`, { headers })).status).toBe(200);
    fail = false;
    expect((await fetch(`${base}/shutdown`, { method: 'POST', headers })).status).toBe(204);
    events.push('reply');
    expect((await fetch(`${base}/shutdown`, { method: 'POST', headers })).status).toBe(409);
    expect((await fetch(`${base}/configs/reload`, { method: 'POST', headers })).status).toBe(409);
    await Bun.sleep(50);
    expect(events).toEqual(['prepare', 'prepare', 'reply', 'shutdown']);
  } finally { api.stop(); }
});
