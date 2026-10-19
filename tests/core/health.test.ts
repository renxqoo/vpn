import { describe, expect, test } from 'bun:test';
import {
  aggregateHealth,
  latestHealth,
  mergeHealthSnapshots,
  probeOnce,
  type HealthSample,
} from '../../src/core/health.ts';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';
import { AnytlsOutbound } from '../../src/outbound/anytls/index.ts';
import { AnytlsClient } from '../../src/outbound/anytls/client.ts';
import { DirectOutbound } from '../../src/outbound/direct.ts';
import type { Outbound } from '../../src/core/types.ts';

describe('health: 纯函数层', () => {
  test('latestHealth 取最近样本并区分 alive', () => {
    const now = Date.now();
    const h: HealthSample[] = [
      { at: now - 3000, delayMs: null },
      { at: now - 2000, delayMs: 120 },
      { at: now - 1000, delayMs: 140 },
    ];
    const latest = latestHealth(h);
    expect(latest?.delayMs).toBe(140);
    expect(latest?.alive).toBe(true);
  });

  test('最近样本失败 → alive false', () => {
    const now = Date.now();
    const latest = latestHealth([{ at: now, delayMs: null }]);
    expect(latest?.alive).toBe(false);
    expect(latest?.delayMs).toBeNull();
  });

  test('空历史 → undefined（区别于失败）', () => {
    expect(latestHealth([])).toBeUndefined();
  });

  test('aggregateHealth：均值延迟、成功率、样本数', () => {
    const now = Date.now();
    const agg = aggregateHealth([
      { at: now - 4000, delayMs: 100 },
      { at: now - 3000, delayMs: 200 },
      { at: now - 2000, delayMs: null },
      { at: now - 1000, delayMs: 300 },
    ]);
    expect(agg.samples).toBe(4);
    expect(agg.successRate).toBe(0.75);
    expect(agg.avgDelayMs).toBe(200);
    expect(agg.alive).toBe(true);
  });

  test('mergeHealthSnapshots：outbound 级快照合并（后写覆盖）', () => {
    const now = Date.now();
    const merged = mergeHealthSnapshots(
      new Map([['a', [{ at: now, delayMs: 50 }]]]),
      new Map([['a', [{ at: now + 1, delayMs: 60 }]], ['b', []]]),
    );
    expect(merged.get('a')?.[0]?.delayMs).toBe(60);
    expect(merged.has('b')).toBe(true);
  });
});

describe('health: probeOnce 行为（本地回环）', () => {
  let server: AnytlsTestServer;
  test(
    'anytls 出站探测：可达节点返回有限延迟；不可达返回 null',
    async () => {
      server = new AnytlsTestServer({ password: 'hp' });
      await server.start();
      const client = new AnytlsClient('probe-node', {
        host: '127.0.0.1',
        port: server.port,
        password: 'hp',
        skipCertVerify: true,
        clientName: 'health-test',
        idleSessionCheckIntervalMs: 60000,
        idleSessionTimeoutMs: 60000,
      });
      const out = new AnytlsOutbound('probe-node', client);
      const delay = await probeOnce(out, 3000);
      expect(delay).not.toBeNull();
      expect(delay as number).toBeGreaterThanOrEqual(0);

      const dead = new AnytlsClient('dead', {
        host: '127.0.0.1',
        port: 1,
        password: 'x',
        skipCertVerify: true,
        clientName: 'health-test',
        idleSessionCheckIntervalMs: 60000,
        idleSessionTimeoutMs: 60000,
      });
      const deadDelay = await probeOnce(new AnytlsOutbound('dead', dead), 3000);
      expect(deadDelay).toBeNull();
      out.close();
      dead.close();
      server.stop();
    },
    { timeout: 15000 },
  );

  test('direct 出站探测 127.0.0.1 echo 场景：返回延迟或 null（不抛）', async () => {
    const d = new DirectOutbound();
    const r = await probeOnce(d, 2000);
    expect(r === null || typeof r === 'number').toBe(true);
    d.close();
  });

  test('无 probe 能力的出站返回 null', async () => {
    const bare: Outbound = {
      name: 'bare',
      connect: () => Promise.reject(new Error('no')),
      close: () => {},
    };
    expect(await probeOnce(bare, 1000)).toBeNull();
  });
});
