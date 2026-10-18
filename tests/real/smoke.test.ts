/**
 * 真实节点冒烟（design.md §3.4/D8）：REAL_SMOKE=1 门控。
 * 拉真实订阅 → 3 个不同地区节点 → AnyTLS 全链路 → cp.cloudflare.com 204 断言。
 */

import { describe, expect, test } from 'bun:test';
import { AnytlsClient } from '../../src/outbound/anytls/client.ts';
import { AnytlsOutbound } from '../../src/outbound/anytls/index.ts';
import { loadSubscription, defaultStore } from '../../src/config/subscription.ts';
import { parseClashConfig } from '../../src/config/clash.ts';
import { CLIENT_NAME } from '../../src/core/version.ts';
import type { SocksAddr } from '../../src/core/socksaddr.ts';

const GATE = process.env.REAL_SMOKE === '1' && Boolean(process.env.REAL_SUB_URL);
const SUB_URL = process.env.REAL_SUB_URL ?? '';

describe('real node smoke (opt-in)', () => {
  test.skipIf(!GATE)(
    'subscription fetch + 3 nodes echo cp.cloudflare.com 204',
    async () => {
      const text = await loadSubscription(SUB_URL, defaultStore('/tmp/bunclash-real-cache'));
      const cfg = parseClashConfig(text);
      const nodes = cfg.proxies.filter((p) => p.kind === 'anytls');
      expect(nodes.length).toBeGreaterThan(0);
      // 地区去重取前 3
      const seenRegion = new Set<string>();
      const picked = [];
      for (const n of nodes) {
        if (n.kind !== 'anytls') continue;
        const region = n.name.replace(/[0-9 (家宽)]+/g, '').trim();
        if (seenRegion.has(region)) continue;
        seenRegion.add(region);
        picked.push(n);
        if (picked.length >= 3) break;
      }
      for (const node of picked) {
        if (node.kind !== 'anytls') continue;
        const client = new AnytlsClient(node.name, {
          host: node.server,
          port: node.port,
          password: node.password,
          sni: node.sni,
          skipCertVerify: node.skipCertVerify,
          idleSessionCheckIntervalMs: 30000,
          idleSessionTimeoutMs: 30000,
          minIdleSession: 5,
          clientName: CLIENT_NAME,
        });
        const outbound = new AnytlsOutbound(node.name, client);
        const target: SocksAddr = { type: 'fqdn', host: 'cp.cloudflare.com', port: 80 };
        const conn = await outbound.connect(target);
        await conn.write(
          new TextEncoder().encode('GET /generate204 HTTP/1.1\r\nHost: cp.cloudflare.com\r\nConnection: close\r\n\r\n'),
        );
        let response = '';
        for (let i = 0; i < 5 && !response.includes('\r\n\r\n'); i++) {
          try {
            const chunk = await conn.read(4096);
            response += new TextDecoder().decode(chunk);
          } catch (_e) {
            break;
          }
        }
        conn.close();
        client.close();
        expect(response).toContain(' 204 ');
      }
    },
    { timeout: 60000 },
  );
});
