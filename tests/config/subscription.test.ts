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
      const text = await defaultStore('').fetch(url);
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
