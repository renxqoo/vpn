import { expect, test } from 'bun:test';
import { RestApi, type ApiDeps } from '../../src/api/server.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { aggregateHealth, type HealthSample } from '../../src/core/health.ts';
import type { Outbound } from '../../src/core/types.ts';
import { RuleEngine } from '../../src/rules/index.ts';

class Node implements Outbound {
  history: HealthSample[] = [];
  action: () => Promise<number | null> = async () => 21;
  constructor(readonly name: string) {}
  connect(): Promise<never> { return Promise.reject(new Error('unused')); }
  close(): void {}
  health() { return aggregateHealth(this.history); }
  async probe(url: string, timeout: number, options?: { isolated?: boolean }) {
    expect(url).toBe('http://cp.cloudflare.com/generate204');
    expect(timeout).toBe(3000);
    expect(options?.isolated).toBe(true);
    const delay = await this.action();
    this.history.push({ at: Date.now(), delayMs: delay });
    return delay;
  }
}
function setup(hooks: Partial<ApiDeps> = {}) {
  const nodes = new Map<string, Outbound>(Array.from({ length: 6 }, (_, i) => {
    const name = `香港 ${i} / %`;
    return [name, new Node(name)];
  }));
  nodes.set('DIRECT', { name: 'DIRECT', connect: () => Promise.reject(new Error('unused')), close() {} });
  const api = new RestApi({
    tracker: new ConnectionTracker(), loopbackPort: 0, secret: 'health-secret',
    outboundOf: (name) => nodes.get(name), outboundNames: () => [...nodes.keys()],
    engine: new RuleEngine({ rules: [], providers: new Map(), geoip: null, final: 'DIRECT' }),
    setMode: () => true, currentMode: () => 'global', ...hooks,
  });
  const headers = { authorization: 'Bearer health-secret' };
  const post = (name: string, custom = headers) => fetch(
    `http://127.0.0.1:${api.port}/proxies/${encodeURIComponent(name)}/healthcheck`, { method: 'POST', headers: custom },
  );
  return { api, nodes, headers, post };
}

test('healthcheck guards Host/auth and reports missing/unsupported nodes; GET never probes', async () => {
  const { api, nodes, headers, post } = setup();
  await api.start('127.0.0.1:0');
  const node = nodes.get('香港 0 / %') as Node;
  try {
    expect((await post(node.name, {} as typeof headers)).status).toBe(401);
    expect((await post(node.name, { ...headers, host: 'external.test' } as typeof headers)).status).toBe(403);
    expect((await post('missing')).status).toBe(404);
    expect((await post('DIRECT')).status).toBe(400);
    await fetch(`http://127.0.0.1:${api.port}/proxies`, { headers });
    expect(node.history).toHaveLength(0);
    const response = await post(node.name);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ health: { alive: true, delay: 21, samples: 1 } });
    node.action = async () => null;
    expect(await (await post(node.name)).json()).toMatchObject({ health: { alive: false, delay: null, samples: 2 } });
    node.action = async () => { throw new Error('injected'); };
    expect((await post(node.name)).status).toBe(500);
    node.action = async () => 0;
    expect(await (await post(node.name)).json()).toMatchObject({ health: { alive: true, delay: 0 } });
  } finally { api.stop(); }
});

test('healthcheck limits concurrency and duplicates; old results are rejected after node replacement', async () => {
  const { api, nodes, post } = setup();
  await api.start('127.0.0.1:0');
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  const firstFour = [...nodes.values()].slice(0, 4) as Node[];
  for (const node of firstFour) node.action = async () => { active++; await pending; return 12; };
  const requests = firstFour.map((node) => post(node.name));
  try {
    const deadline = Date.now() + 2000;
    while (active < 4 && Date.now() < deadline) await Bun.sleep(5);
    expect(active).toBe(4);
    expect((await post('香港 4 / %')).status).toBe(429);
    expect((await post(firstFour[0]!.name)).status).toBe(429);
    nodes.set(firstFour[0]!.name, new Node(firstFour[0]!.name));
    release();
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([409, 200, 200, 200]);
    expect((await post(firstFour[0]!.name)).status).toBe(200);
  } finally { release(); await Promise.allSettled(requests); api.stop(); }
});

test('healthcheck rejects new probes while reloading or preparing shutdown', async () => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  let pending = new Promise<void>((resolve) => { release = resolve; });
  let started = new Promise<void>((resolve) => { entered = resolve; });
  const { api, headers, post } = setup({
    reloadConfig: async () => { entered(); await pending; },
    prepareShutdown: async () => { entered(); await pending; }, shutdown: async () => {},
  });
  await api.start('127.0.0.1:0');
  try {
    const reload = fetch(`http://127.0.0.1:${api.port}/configs/reload`, { method: 'POST', headers });
    await started;
    expect((await post('香港 0 / %')).status).toBe(409);
    release();
    expect((await reload).status).toBe(204);
    expect((await post('香港 0 / %')).status).toBe(200);
    pending = new Promise<void>((resolve) => { release = resolve; });
    started = new Promise<void>((resolve) => { entered = resolve; });
    const shutdown = fetch(`http://127.0.0.1:${api.port}/shutdown`, { method: 'POST', headers });
    await started;
    expect((await post('香港 0 / %')).status).toBe(409);
    release();
    expect((await shutdown).status).toBe(204);
    await Bun.sleep(30);
  } finally { release(); api.stop(); }
});
