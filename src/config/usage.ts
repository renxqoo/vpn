/**
 * 订阅用量（design.md §1.1 交互式 CLI）：subscription-userinfo 头解析与展示。
 * 头格式：upload=123; download=456; total=789; expire=1700000000（字节 / Unix 秒）
 */

import { logger } from '../core/log.ts';

const log = logger('sub:usage');

export interface SubscriptionUsage {
  upload: number;
  download: number;
  total: number | null;
  expire: number | null;
}

export function parseUserinfo(header: string | null): SubscriptionUsage | null {
  if (!header) return null;
  const out: Partial<SubscriptionUsage> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (!Number.isFinite(value) || value < 0) continue;
    if (key === 'upload' || key === 'download') out[key] = value;
    if (key === 'total') out.total = value;
    if (key === 'expire') out.expire = value;
  }
  if (out.upload === undefined || out.download === undefined) return null;
  return {
    upload: out.upload,
    download: out.download,
    total: out.total ?? null,
    expire: out.expire ?? null,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

/** 用量文本视图（CLI 展示与测试断言共用） */
export function renderUsage(u: SubscriptionUsage, style: 'plain' | 'clack' = 'plain'): string[] {
  const lines: string[] = [];
  const used = u.upload + u.download;
  if (u.total !== null && u.total > 0) {
    const remain = Math.max(u.total - used, 0);
    const pct = Math.min(used / u.total, 1);
    const barWidth = 24;
    const filled = Math.round(pct * barWidth);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
    lines.push(`流量  ${bar} ${(pct * 100).toFixed(1)}%`);
    lines.push(`  已用 ${formatBytes(used)} / 总量 ${formatBytes(u.total)}`);
    lines.push(`  上传 ${formatBytes(u.upload)} · 下载 ${formatBytes(u.download)}`);
    lines.push(`  剩余 ${formatBytes(remain)}`);
  } else {
    lines.push(`流量  已用 ${formatBytes(used)}（↑${formatBytes(u.upload)} ↓${formatBytes(u.download)}），订阅未提供总量`);
  }
  if (u.expire !== null) {
    const expireDate = new Date(u.expire * 1000);
    const daysLeft = (u.expire * 1000 - Date.now()) / 86400000;
    const y = expireDate.getFullYear();
    const mo = String(expireDate.getMonth() + 1).padStart(2, '0');
    const d = String(expireDate.getDate()).padStart(2, '0');
    const ymd = `${y}-${mo}-${d}`;
    if (daysLeft >= 0) {
      lines.push(`到期  ${ymd}（剩 ${Math.floor(daysLeft)} 天）`);
    } else {
      lines.push(`到期  ${ymd}（已过期 ${Math.floor(-daysLeft)} 天）`);
    }
  } else {
    lines.push('到期  订阅未提供到期时间');
  }
  if (style === 'clack') {
    return lines.map((l) => (l.startsWith('  ') ? l : `│ ${l}`));
  }
  return lines;
}

/** 拉订阅头（不动 body——HEAD 不一定被支持，GET 但不读全 body 前取消） */
export type UserinfoResult =
  | { kind: 'ok'; usage: SubscriptionUsage }
  | { kind: 'unsupported' }
  | { kind: 'network-error'; error: string };

export async function fetchUserinfo(url: string): Promise<UserinfoResult> {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'clash-verge/v2.0.0' },
      signal: AbortSignal.timeout(15_000),
    });
    const header = r.headers.get('subscription-userinfo');
    // body 不需要：取消以省流量
    try {
      await r.body?.cancel();
    } catch (_e) {
      /* noop */
    }
    const parsed = parseUserinfo(header);
    if (!parsed) return { kind: 'unsupported' };
    return { kind: 'ok', usage: parsed };
  } catch (e) {
    const error = String(e).slice(0, 120);
    log.warn(`fetch subscription failed: ${error}`);
    return { kind: 'network-error', error };
  }
}
