import type { Outbound } from './types.ts';

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
}

const HISTORY_LIMIT = 10;

export function recordSample(history: HealthSample[], sample: HealthSample): HealthSample[] {
  const next = [...history, sample];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

export function latestHealth(history: HealthSample[]): { alive: boolean; delayMs: number | null } | undefined {
  const last = history[history.length - 1];
  if (last === undefined) return undefined;
  return { alive: last.delayMs !== null && last.delayMs > 0, delayMs: last.delayMs };
}

export function aggregateHealth(history: HealthSample[]): HealthSummary {
  const last = latestHealth(history);
  const ok = history.filter((s) => s.delayMs !== null && s.delayMs > 0);
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
