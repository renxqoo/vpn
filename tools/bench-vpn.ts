/** 回环性能基准：同机前后对照；不访问真实订阅、不调整协议安全参数。 */
import { App } from '../src/app.ts';
import { AnytlsClient } from '../src/outbound/anytls/client.ts';
import { AnytlsOutbound } from '../src/outbound/anytls/index.ts';
import { AnytlsTestServer } from '../src/outbound/anytls/testing/server.ts';
import { setLogLevel } from '../src/core/log.ts';
import type { ClashConfig } from '../src/config/clash.ts';
import type { Conn } from '../src/core/types.ts';

setLogLevel('silent');
const server = new AnytlsTestServer({ password: 'bench' });
await server.start();
const target = { type: 'fqdn' as const, host: 'bench.test', port: 80 };
const payload = new Uint8Array(64 * 1024).fill(42);
const percentile = (samples: number[], p: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.floor((sorted.length - 1) * p)]!.toFixed(3));
};
async function exchange(conn: Conn, data: Uint8Array): Promise<void> {
  await conn.write(data);
  let received = 0;
  while (received < data.length) {
    const chunk = await conn.read();
    if (chunk[0] !== 42 || chunk.at(-1) !== 42) throw new Error('payload corrupted');
    received += chunk.length;
  }
  if (received !== data.length) throw new Error('payload length mismatch');
}
async function httpTunnel(port: number): Promise<Conn> {
  const chunks: Uint8Array[] = [];
  let wake: ((chunk: Uint8Array) => void) | null = null;
  let ready: () => void = () => {};
  let header = Buffer.alloc(0);
  let established = false;
  const connected = new Promise<void>((resolve) => { ready = resolve; });
  const socket = await Bun.connect({
    hostname: '127.0.0.1', port,
    socket: {
      data(_socket, raw) {
        let data: Uint8Array = raw;
        if (!established) {
          header = Buffer.concat([header, raw]);
          const end = header.indexOf('\r\n\r\n');
          if (end < 0) return;
          if (!header.toString().startsWith('HTTP/1.1 200')) throw new Error('CONNECT failed');
          established = true;
          ready();
          data = header.subarray(end + 4);
        }
        if (data.length === 0) return;
        if (wake) {
          const resolve = wake;
          wake = null;
          resolve(data);
        } else chunks.push(data);
      },
    },
  });
  socket.write('CONNECT bench.test:80 HTTP/1.1\r\nHost: bench.test:80\r\n\r\n');
  await connected;
  return {
    closed: false,
    write: async (data) => socket.write(data),
    read: () => chunks.length > 0 ? Promise.resolve(chunks.shift()!) : new Promise((resolve) => { wake = resolve; }),
    close: () => { socket.end(); },
  };
}
function config(selected: string): ClashConfig {
  return {
    httpPort: 0, socksPort: 0, mode: 'rule', logLevel: 'silent', apiAddr: '127.0.0.1:0', apiSecret: '',
    proxies: ['A', 'B'].map((name) => ({
      kind: 'anytls', name, server: '127.0.0.1', port: server.port, password: 'bench', skipCertVerify: true,
      udp: false, idleSessionCheckIntervalSec: 30, idleSessionTimeoutSec: 30, minIdleSession: 5,
    })),
    groups: [{ name: '🚀 节点选择', type: 'select', proxies: selected === 'A' ? ['A', 'B'] : ['B', 'A'] }],
    rules: [{ type: 'MATCH', payload: '', target: '🚀 节点选择', noResolve: false, raw: '' }],
    ruleProviders: new Map(),
  };
}
const app = new App({ config: config('A'), cacheDir: '/tmp/bunclash-perf-cache' });
const outbound = new AnytlsOutbound('transfer', new AnytlsClient('transfer', {
  host: '127.0.0.1', port: server.port, password: 'bench', skipCertVerify: true, clientName: 'bench',
}));
try {
  const conn = await outbound.connect(target);
  for (let i = 0; i < 32; i++) await exchange(conn, payload);
  const throughputs: number[] = [];
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    for (let i = 0; i < 512; i++) await exchange(conn, payload);
    // 回显统计单向用户载荷；同时传输了相同大小的上行和下行。
    throughputs.push(32 / ((performance.now() - start) / 1000));
  }
  conn.close();
  await app.start();
  const tunnel = await httpTunnel(app.httpPort);
  for (let i = 0; i < 32; i++) await exchange(tunnel, payload);
  const proxyThroughputs: number[] = [];
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    for (let i = 0; i < 512; i++) await exchange(tunnel, payload);
    proxyThroughputs.push(32 / ((performance.now() - start) / 1000));
  }
  tunnel.close();
  const latencies: number[] = [];
  let reused = 0;
  for (let i = 0; i < 80; i++) {
    const before = app.outboundOf('A');
    const start = performance.now();
    await app.reload(config(i % 2 === 0 ? 'B' : 'A'));
    if (app.outboundOf('A') === before) reused++;
    const stream = await app.outboundOf('🚀 节点选择')!.connect(target);
    await exchange(stream, payload.subarray(0, 128));
    stream.close();
    if (i >= 10) latencies.push(performance.now() - start);
  }
  console.log(JSON.stringify({
    bun: Bun.version, blockBytes: payload.length, transferMiBPerRound: 32, rounds: throughputs.length,
    echoMiBpsMedian: percentile(throughputs, 0.5), echoMiBpsRounds: throughputs.map((n) => Number(n.toFixed(2))),
    httpProxyEchoMiBpsMedian: percentile(proxyThroughputs, 0.5),
    httpProxyEchoMiBpsRounds: proxyThroughputs.map((n) => Number(n.toFixed(2))),
    reloadAndConnectMsP50: percentile(latencies, 0.5), reloadAndConnectMsP95: percentile(latencies, 0.95),
    reusedClients: reused, reloads: 80,
  }, null, 2));
} finally {
  outbound.close();
  await app.stop();
  server.stop();
}

// 两版统一在测量和清理结束后退出，旧版未清理的 idle timeout 不延长基准进程。
process.exit(0);
