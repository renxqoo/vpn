/** 节点健康展示与按需刷新；只在命令运行时请求 API。 */
import { NODE_CHECK_CONCURRENCY } from '../core/health.ts';

export interface NodeHealth {
  alive: boolean;
  delay: number | null;
  samples: number;
  checkedAt: number | null;
}
export type NodeHealthMap = Record<string, NodeHealth>;

function parseHealth(input: unknown): NodeHealth | null {
  if (!input || typeof input !== 'object') return null;
  const h = input as NodeHealth;
  if (typeof h.alive !== 'boolean' || !Number.isInteger(h.samples) || h.samples < 0 ||
    (h.delay !== null && (typeof h.delay !== 'number' || !Number.isFinite(h.delay) || h.delay < 0))) return null;
  return { alive: h.alive, delay: h.delay, samples: h.samples,
    checkedAt: typeof h.checkedAt === 'number' && Number.isFinite(h.checkedAt) ? h.checkedAt : null };
}

export function healthFromProxies(proxies: Record<string, { health?: unknown }>): NodeHealthMap {
  const out: NodeHealthMap = Object.create(null) as NodeHealthMap;
  for (const [name, info] of Object.entries(proxies)) {
    const health = parseHealth(info.health);
    if (health) out[name] = health;
  }
  return out;
}

export function formatNodeHealth(health?: NodeHealth, now = Date.now()): string {
  if (!health || health.samples === 0) return '未探测 · —';
  const label = health.alive && health.delay !== null ? `可用 · ${health.delay}ms` : '不可用/超时 · —';
  return label + (health.checkedAt !== null && now - health.checkedAt > 300_000 ? ' · 上次结果' : '');
}

export function nodeHealthLines(names: string[], health: NodeHealthMap): string[] {
  return names.map((name) => `${name}  ${formatNodeHealth(Object.hasOwn(health, name) ? health[name] : undefined)}`);
}

const auth = (secret: string) => secret ? { authorization: `Bearer ${secret}` } : undefined;

export async function fetchNodeHealth(apiPort: number, secret = ''): Promise<NodeHealthMap | null> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${apiPort}/proxies`, {
      headers: auth(secret), signal: AbortSignal.timeout(1500),
    });
  } catch (_e) { return null; }
  if (!response.ok) throw new Error(`无法读取节点状态（API ${response.status}），请检查内核鉴权配置`);
  const data = await response.json() as { proxies: Record<string, { health?: unknown }> };
  return healthFromProxies(data.proxies);
}

export async function checkNodeHealth(
  names: string[], apiPort: number, secret: string, onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let cursor = 0;
  let done = 0;
  let failure: string | null = null;
  const worker = async () => {
    while (cursor < names.length && failure === null) {
      const name = names[cursor++]!;
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}/proxies/${encodeURIComponent(name)}/healthcheck`, {
          method: 'POST', headers: auth(secret), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          failure = response.status === 404
            ? `节点 ${name} 不在运行配置中，或旧内核不支持探测；请用新版 start 启动后重试`
            : `节点 ${name} 探测请求失败（API ${response.status}），请稍后重试`;
        } else {
          const data = await response.json() as { health?: unknown };
          const health = parseHealth(data.health);
          if (!health || health.samples === 0) failure = `节点 ${name} 未返回有效探测结果，请检查内核版本`;
        }
      } catch (_e) { failure = `节点 ${name} 的探测 API 不可达或请求超时，请检查内核运行状态`; }
      onProgress?.(++done, names.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NODE_CHECK_CONCURRENCY, names.length) }, worker));
  if (failure !== null) throw new Error(failure);
}
