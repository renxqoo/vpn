import { describe, expect, test } from 'bun:test';
import { AutoGroup, SelectGroup, buildGroup } from '../../src/rules/groups.ts';
import type { Conn, Outbound } from '../../src/core/types.ts';
import type { SocksAddr } from '../../src/core/socksaddr.ts';

class StubOutbound implements Outbound {
  readonly name: string;
  delayMs: number | null;
  connectCalls = 0;
  constructor(name: string, delayMs: number | null) {
    this.name = name;
    this.delayMs = delayMs;
  }
  connect(_target: SocksAddr): Promise<Conn> {
    this.connectCalls++;
    return Promise.reject(new Error('stub'));
  }
  async probe(_url: string, _timeoutMs: number): Promise<number | null> {
    return this.delayMs;
  }
  close(): void {}
}

function members(): Map<string, Outbound> {
  return new Map<string, Outbound>([
    ['fast', new StubOutbound('fast', 50)],
    ['mid', new StubOutbound('mid', 150)],
    ['dead', new StubOutbound('dead', null)],
  ]);
}

describe('select group', () => {
  test('initial member is first; select switches; unknown rejected', () => {
    const g = new SelectGroup('sel', members(), 'fast');
    expect(g.current()).toBe('fast');
    expect(g.select('mid')).toBe(true);
    expect(g.current()).toBe('mid');
    expect(g.select('nope')).toBe(false);
    expect(g.current()).toBe('mid');
    expect(g.memberNames()).toContain('dead');
  });

  test('connect routes through current member', async () => {
    const m = members();
    const g = new SelectGroup('sel', m, 'mid');
    await g.connect({ type: 'fqdn', host: 'x', port: 1 }).catch(() => {});
    expect((m.get('mid') as StubOutbound).connectCalls).toBe(1);
    expect((m.get('fast') as StubOutbound).connectCalls).toBe(0);
  });
});

describe('url-test group', () => {
  test('picks lowest delay after probe; dead excluded', async () => {
    const m = members();
    const g = buildGroup({ name: 'auto', type: 'url-test', proxies: ['fast', 'mid', 'dead'] }, m);
    if (!(g instanceof AutoGroup)) throw new Error('type');
    await g.probeAll(1000);
    expect(g.current()).toBe('fast');
    const delays = g.delays();
    expect(delays['fast']).toBe(50);
    expect(delays['dead']).toBe(-1); // probe failure recorded as -1, excluded from picking
  });

  test('tolerance keeps current unless clearly better', async () => {
    const m = new Map<string, Outbound>([
      ['a', new StubOutbound('a', 100)],
      ['b', new StubOutbound('b', 95)],
    ]);
    const g = new AutoGroup(
      { name: 't', type: 'url-test', proxies: ['a', 'b'], tolerance: 50 },
      m,
    );
    await g.probeAll(500);
    // b 只快 5ms < tolerance 50 → 保持初始 a
    expect(g.current()).toBe('a');
  });
});

describe('fallback group', () => {
  test('uses first alive in order', async () => {
    const m = new Map<string, Outbound>([
      ['primary', new StubOutbound('primary', null)],
      ['backup', new StubOutbound('backup', 120)],
    ]);
    const g = buildGroup({ name: 'fb', type: 'fallback', proxies: ['primary', 'backup'] }, m);
    if (!(g instanceof AutoGroup)) throw new Error('type');
    expect(g.current()).toBe('primary'); // 初始
    await g.probeAll(500);
    expect(g.current()).toBe('backup');
  });
});
