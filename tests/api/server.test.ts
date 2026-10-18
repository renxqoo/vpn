import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RestApi } from '../../src/api/server.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { RuleEngine } from '../../src/rules/index.ts';
import { parseRuleLine } from '../../src/config/clash.ts';
import { SelectGroup } from '../../src/rules/groups.ts';
import { DirectOutbound } from '../../src/outbound/direct.ts';

let api: RestApi;
let apiWithSecret: RestApi;
const group = new SelectGroup('选择', new Map([['DIRECT', new DirectOutbound()]]), 'DIRECT');
const tracker = new ConnectionTracker();
const engine = new RuleEngine({
  rules: [parseRuleLine('MATCH,DIRECT')],
  providers: new Map(),
  geoip: null,
  final: 'DIRECT',
});

let modeState: 'rule' | 'global' | 'direct' = 'rule';

beforeAll(async () => {
  api = new RestApi({
    tracker,
    outboundOf: (n) => (n === '选择' ? group : n === 'DIRECT' ? new DirectOutbound() : undefined),
    outboundNames: () => ['选择', 'DIRECT'],
    engine,
    secret: '',
    setMode: (m) => {
      modeState = m;
      return true;
    },
    currentMode: () => modeState,
  });
  await api.start('127.0.0.1:0');
  apiWithSecret = new RestApi({
    tracker,
    outboundOf: (n) => (n === '选择' ? group : undefined),
    outboundNames: () => ['选择'],
    engine,
    secret: 's3cret',
    setMode: (m) => {
      modeState = m;
      return true;
    },
    currentMode: () => modeState,
  });
  await apiWithSecret.start('127.0.0.1:0');
});

afterAll(() => {
  api.stop();
  apiWithSecret.stop();
});

describe('rest api', () => {
  test('GET /version', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/version`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ version: '1.0.0' });
  });

  test('GET /proxies lists selector with now/all', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/proxies`);
    const j = await r.json() as { proxies: Record<string, { type: string; now: string }> };
    expect(j.proxies['选择']?.type).toBe('Selector');
    expect(j.proxies['选择']?.now).toBe('DIRECT');
  });

  test('PUT /proxies/:name switches selector', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent('选择')}`, {
      method: 'PUT',
      body: JSON.stringify({ now: 'DIRECT' }),
    });
    expect(r.status).toBe(204);
    const r2 = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent('选择')}`);
    const j = await r2.json() as { now: string };
    expect(j.now).toBe('DIRECT');
  });

  test('PUT with unknown member → 400', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/proxies/${encodeURIComponent('选择')}`, {
      method: 'PUT',
      body: JSON.stringify({ now: 'nope' }),
    });
    expect(r.status).toBe(400);
  });

  test('PUT on non-selector → 400', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/proxies/DIRECT`, {
      method: 'PUT',
      body: JSON.stringify({ now: 'x' }),
    });
    expect(r.status).toBe(400);
  });

  test('GET /rules', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/rules`);
    const j = await r.json() as { rules: { type: string; target: string }[] };
    expect(j.rules[0]?.type).toBe('MATCH');
  });

  test('GET /connections + DELETE missing → 404', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/connections`);
    const j = await r.json() as { connections: unknown[] };
    expect(Array.isArray(j.connections)).toBe(true);
    const d = await fetch(`http://127.0.0.1:${api.port}/connections/nope`, { method: 'DELETE' });
    expect(d.status).toBe(404);
  });

  test('unknown endpoint → 404', async () => {
    const r = await fetch(`http://127.0.0.1:${api.port}/nope`);
    expect(r.status).toBe(404);
  });

  test('PATCH /configs switches mode; GET reads back; invalid → 400', async () => {
    const base = `http://127.0.0.1:${api.port}`;
    const bad = await fetch(`${base}/configs`, { method: 'PATCH', body: JSON.stringify({ mode: 'nope' }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/configs`, {
      method: 'PATCH',
      body: JSON.stringify({ mode: 'global' }),
    });
    expect(ok.status).toBe(204);
    const get = await fetch(`${base}/configs`);
    expect(await get.json()).toEqual({ mode: 'global' });
    // 还原
    await fetch(`${base}/configs`, { method: 'PATCH', body: JSON.stringify({ mode: 'rule' }) });
  });

  test('secret enforced: no/wrong auth → 401, correct → 200', async () => {
    const base = `http://127.0.0.1:${apiWithSecret.port}`;
    expect((await fetch(`${base}/version`)).status).toBe(401);
    expect((await fetch(`${base}/version`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await fetch(`${base}/version`, { headers: { authorization: 'Bearer s3cret' } });
    expect(ok.status).toBe(200);
  });
});
