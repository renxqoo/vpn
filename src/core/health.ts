import type { Conn, Outbound } from './types.ts';

export interface HealthSample {
  at: number;
  delayMs: number | null;
}

export interface HealthSummary {
  alive: boolean;
  delayMs: number | null;
  samples: number;
  successRate: number;
  avgDelayMs: number | null;
  checkedAt: number | null;
}

const HISTORY_LIMIT = 10;

export function recordSample(history: HealthSample[], sample: HealthSample): HealthSample[] {
  const next = [...history, sample];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

export function latestHealth(history: HealthSample[]): { alive: boolean; delayMs: number | null } | undefined {
  const last = history[history.length - 1];
  if (last === undefined) return undefined;
  return { alive: last.delayMs !== null && last.delayMs >= 0, delayMs: last.delayMs };
}

export function aggregateHealth(history: HealthSample[]): HealthSummary {
  const last = latestHealth(history);
  const ok = history.filter((s) => s.delayMs !== null && s.delayMs >= 0);
  const avg =
    ok.length > 0
      ? Math.round(ok.reduce((n, s) => n + (s.delayMs as number), 0) / ok.length)
      : null;
  return {
    alive: last?.alive ?? false,
    delayMs: last?.delayMs ?? null,
    samples: history.length,
    successRate: history.length > 0 ? ok.length / history.length : 0,
    avgDelayMs: avg,
    checkedAt: history[history.length - 1]?.at ?? null,
  };
}

export function mergeHealthSnapshots(
  ...maps: Map<string, HealthSample[]>[]
): Map<string, HealthSample[]> {
  const out = new Map<string, HealthSample[]>();
  for (const m of maps) {
    for (const [k, v] of m) out.set(k, v);
  }
  return out;
}

/** 单次探测：连接 → 发 HEAD → 读到响应头即成功；失败/超时 null */
export async function probeOnce(outbound: Outbound, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  let settled = false;
  try {
    if (!outbound.probe) return null;
    return await outbound.probe('http://cp.cloudflare.com/generate204', timeoutMs);
  } catch (_e) {
    return null;
  } finally {
    settled = true;
    void settled;
  }
}

export const HEALTH_HISTORY_LIMIT = HISTORY_LIMIT;

export const NODE_CHECK_CONCURRENCY = 4;
export const NODE_CHECK_TIMEOUT = 3000;
export const NODE_CHECK_URL = 'http://cp.cloudflare.com/generate204';

/** 总时限覆盖建连、写请求和首个回应；超时后的迟到流也必须关闭。 */
export async function probeConnection(
  outbound: Pick<Outbound, 'connect'>, rawUrl: string, timeoutMs: number,
): Promise<number | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  let conn: Conn | undefined;
  let finished = false;
  const close = (stream: Conn) => { try { stream.close(); } catch (_e) { /* 探测清理不影响其它流 */ } };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const start = performance.now();
  const work = (async () => {
    const url = new URL(rawUrl);
    const path = `${url.pathname || '/'}${url.search}`;
    if (url.protocol !== 'http:' || path.length > 2048 || url.host.length > 255) return null;
    const stream = await outbound.connect({ type: 'fqdn', host: url.hostname, port: Number(url.port) || 80 });
    if (finished) { close(stream); return null; }
    conn = stream;
    await stream.write(new TextEncoder().encode(`HEAD ${path} HTTP/1.0\r\nHost: ${url.host}\r\n\r\n`));
    const response = await stream.read(128);
    return response.length ? Math.max(0, Math.round(performance.now() - start)) : null;
  })().catch(() => null);
  try { return await Promise.race([work, timeout]); }
  finally { finished = true; clearTimeout(timer); if (conn) close(conn); }
}
