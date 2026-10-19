import { describe, expect, test } from 'bun:test';
import { defaultStore } from '../../src/config/subscription.ts';
import { parseClashConfig } from '../../src/config/clash.ts';
import { fetchUserinfo } from '../../src/config/usage.ts';

describe('subscription client compatibility', () => {
  test('client-gated provider accepts config download and usage requests', async () => {
    const yaml = `proxies:
  - {name: test, type: anytls, server: test.example.net, port: 443, password: test}
rules:
  - MATCH,test
`;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (req.headers.get('user-agent') !== 'mihomo') {
          return new Response('PLEASE UPGRADE CLIENT', { status: 403 });
        }
        return new Response(yaml, {
          headers: { 'subscription-userinfo': 'upload=10; download=20; total=100' },
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/subscribe?token=test`;
      const text = await defaultStore('', url).fetch(url);
      const cfg = parseClashConfig(text);
      expect(cfg.proxies).toHaveLength(1);
      expect(cfg.proxies[0]?.kind).toBe('anytls');
      const usage = await fetchUserinfo(url);
      expect(usage.kind).toBe('ok');
      if (usage.kind === 'ok') expect(usage.usage.total).toBe(100);
    } finally {
      server.stop(true);
    }
  });
});

describe('subscription cache isolation', () => {
  test('new URL cannot fall back to another subscription; same URL can use its cache', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadSubscription } = await import('../../src/config/subscription.ts');
    const dir = mkdtempSync(join(tmpdir(), 'vpn-sub-cache-'));
    const yaml = 'proxies: []\nrules:\n  - MATCH,DIRECT\n';
    const a = defaultStore(dir, 'https://a.test/subscribe');
    const b = defaultStore(dir, 'https://b.test/subscribe');
    try {
      expect(a.cachePath).not.toBe(b.cachePath);
      await loadSubscription('https://a.test/subscribe', { ...a, fetch: async () => yaml });
      const offline = async () => { throw new Error('offline'); };
      expect(await loadSubscription('https://a.test/subscribe', { ...a, fetch: offline })).toBe(yaml);
      await expect(loadSubscription('https://b.test/subscribe', { ...b, fetch: offline })).rejects.toThrow();
      // 200 返回的错误页不能污染已验证的缓存。
      expect(await loadSubscription('https://a.test/subscribe', {
        ...a, fetch: async () => '<html>invalid subscription</html>',
      })).toBe(yaml);
      expect(await loadSubscription('https://a.test/subscribe', {
        ...a, fetch: async () => 'message: subscription expired',
      })).toBe(yaml);
      expect(await Bun.file(a.cachePath!).text()).toBe(yaml);
      await Bun.write(b.cachePath!, '<html>bad cache</html>');
      await expect(loadSubscription('https://b.test/subscribe', { ...b, fetch: offline })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
