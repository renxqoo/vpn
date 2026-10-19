import { expect, test } from 'bun:test';
import { checkNodeHealth, fetchNodeHealth, formatNodeHealth, healthFromProxies } from '../../src/config/node-health.ts';
import { nodeHealthLines } from '../../src/config/node-health.ts';

test('full node view distinguishes missing, failed, zero latency and old results without region deduplication', () => {
  const now = Date.now();
  const health = healthFromProxies({
    '香港 01': { health: { alive: false, delay: null, samples: 0 } },
    '香港 02': { health: { alive: true, delay: 0, samples: 1, checkedAt: now } },
    '香港 03': { health: { alive: false, delay: null, samples: 1, checkedAt: now } },
    old: { health: { alive: true, delay: 123, samples: 1, checkedAt: now - 300_001 } },
    malformed: { health: { alive: true, delay: -10, samples: 1 } },
    direct: {},
  });
  const lines = nodeHealthLines(['香港 01', '香港 02', '香港 03', 'missing'], health);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain('未探测');
  expect(lines[1]).toContain('可用 · 0ms');
  expect(lines[2]).toContain('不可用/超时');
  expect(lines[3]).toContain('未探测');
  expect(health.malformed).toBeUndefined();
  expect(formatNodeHealth(health.old, now)).toBe('可用 · 123ms · 上次结果');
  expect(formatNodeHealth(undefined)).toBe('未探测 · —');
  for (const line of nodeHealthLines(['constructor', 'toString', '__proto__'], {})) {
    expect(line).toContain('未探测');
  }
});

test('health read authenticates, does not probe, and distinguishes offline from forbidden', async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => {
    calls++;
    if (request.headers.get('authorization') !== 'Bearer secret') return new Response('', { status: 401 });
    expect(request.method).toBe('GET');
    return Response.json({ proxies: { node: { health: { alive: true, delay: 12, samples: 2 } } } });
  } });
  try {
    expect((await fetchNodeHealth(server.port!, 'secret'))?.node?.delay).toBe(12);
    await expect(fetchNodeHealth(server.port!, 'wrong')).rejects.toThrow('鉴权');
    expect(calls).toBe(2);
  } finally { server.stop(true); }
  expect(await fetchNodeHealth(server.port!, 'secret')).toBeNull();
});

test('manual checks use at most four requests, safely encode node names and report partial progress', async () => {
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const progress: number[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe('Bearer secret');
    peak = Math.max(peak, ++active);
    const path = new URL(request.url).pathname;
    seen.push(decodeURIComponent(path.slice('/proxies/'.length, -'/healthcheck'.length)));
    await Bun.sleep(10);
    active--;
    return Response.json({ health: { alive: true, delay: 10, samples: 1 } });
  } });
  const names = ['香港 01', '香港 02 / % &', ...Array.from({ length: 7 }, (_, i) => `node ${i}`)];
  try {
    await checkNodeHealth(names, server.port!, 'secret', (done) => progress.push(done));
    expect(peak).toBe(4);
    expect(seen.sort()).toEqual([...names].sort());
    expect(progress).toEqual(Array.from({ length: names.length }, (_, i) => i + 1));
  } finally { server.stop(true); }
});

for (const status of [404, 429, 401, 200]) {
  test(`manual checks report unsupported/busy/auth/malformed result (${status}) without false success`, async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: () => Response.json({}, { status }) });
    try { await expect(checkNodeHealth(['node'], server.port!, '')).rejects.toThrow(); }
    finally { server.stop(true); }
    await expect(checkNodeHealth(['node'], server.port!, '')).rejects.toThrow('不可达');
  });
}
