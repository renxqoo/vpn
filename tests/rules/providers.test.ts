import { describe, expect, test } from 'bun:test';
import { parseProviderPayload, RuleProviders, type ProviderStore } from '../../src/rules/providers.ts';
import type { RuleProviderConfig } from '../../src/config/clash.ts';

function makeStore(files: Map<string, string>): ProviderStore & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    cacheDir: () => '/tmp/bunclash-provider-test',
    async fetch(u: string) {
      fetched.push(u);
      const f = files.get(u);
      if (f === undefined) throw new Error('offline');
      return f;
    },
    async readFile(p: string) {
      return files.get(p) ?? null;
    },
    now: () => 1700000000000,
  };
}

function cfg(name: string, url: string): RuleProviderConfig {
  return { name, behavior: 'domain', format: 'yaml', url, interval: 86400 };
}

describe('rule providers lifecycle', () => {
  test('fetch success resolves domains', async () => {
    const store = makeStore(new Map([['http://x/a.txt', 'payload:\n  - \'+.a.com\'\n']]));
    const rp = new RuleProviders(new Map([['a', cfg('a', 'http://x/a.txt')]]), store);
    await rp.loadAll();
    const rt = rp.getRuntime().get('a');
    expect(rt?.resolved.domains?.suffixes.has('a.com')).toBe(true);
    rp.stop();
  });

  test('fetch failure with cache fallback', async () => {
    const store = makeStore(new Map());
    // 预置缓存文件
    await Bun.write('/tmp/bunclash-provider-test/ruleset-b.txt', 'payload:\n  - b.com\n');
    const rp = new RuleProviders(new Map([['b', cfg('b', 'http://x/b.txt')]]), store);
    await rp.loadAll();
    const rt = rp.getRuntime().get('b');
    expect(rt?.resolved.domains?.suffixes.has('b.com')).toBe(true);
    rp.stop();
  });

  test('no source → empty set, not fatal', async () => {
    const store = makeStore(new Map());
    const rp = new RuleProviders(new Map([['c', { ...cfg('c', 'http://x/c.txt') }]]), store);
    await rp.loadAll();
    expect(rp.getRuntime().get('c')?.resolved).toEqual({});
    rp.stop();
  });
});

describe('classical payload variants', () => {
  test('entries with target column parse to placeholder rules', () => {
    const text = 'payload:\n  - DOMAIN-SUFFIX,openai.com,PROXY\n  - IP-CIDR,1.2.3.4/32,DIRECT,no-resolve\n';
    const r = parseProviderPayload(text, 'classical');
    expect(r.classical?.length).toBe(2);
    const second = r.classical?.[1];
    expect(second?.type).toBe('IP-CIDR');
    expect(second?.noResolve).toBe(true);
  });
  test('MATCH entry accepted', () => {
    const r = parseProviderPayload('payload:\n  - MATCH,DIRECT\n', 'classical');
    expect(r.classical?.[0]?.type).toBe('MATCH');
  });
});

test('stopping a provider during initial load cannot recreate its refresh timer', async () => {
  let release: (value: string) => void = () => {};
  let fetches = 0;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const provider = new RuleProviders(new Map([['late', {
    ...cfg('late', 'http://late.test/rules'), interval: 0.005,
  }]]), {
    cacheDir: () => null,
    fetch: async () => { fetches++; return pending; },
    readFile: async () => null,
    now: () => Date.now(),
  });
  const loading = provider.loadAll();
  provider.stop();
  release('payload:\n  - test.example\n');
  await loading;
  await Bun.sleep(40);
  expect(fetches).toBe(1);
  provider.stop();
});
