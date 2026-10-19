/** 核心接口（design.md §2 core/types）：入站出站解耦的 Proxy 抽象。 */

import type { SocksAddr } from './socksaddr.ts';

/** 出站连接：流式读写 + 关闭 + 字节统计 */
export interface Conn {
  write(data: Uint8Array): Promise<number>;
  read(max?: number): Promise<Uint8Array>;
  close(): void;
  readonly closed: boolean;
}

/** 出站提供者：给定目标地址建立隧道连接 */
export interface Outbound {
  readonly name: string;
  connect(target: SocksAddr): Promise<Conn>;
  /** 可选：延迟探测（策略组 url-test 用；不支持返回 null） */
  probe?(url: string, timeoutMs: number, options?: { isolated?: boolean }): Promise<number | null>;
  close(): void;
}

/** 路由决策上下文 */
export interface RouteContext {
  host: string; // 域名（小写、无尾点）或 IP 文本
  port: number;
  /** host 已是 IP 时为 true */
  isIp: boolean;
}

export type RouteDecision = { outbound: string } | { reject: true };

export interface Router {
  resolve(ctx: RouteContext): RouteDecision;
}

/** 活动连接台账条目（API /connections） */
export interface ConnectionInfo {
  id: string;
  protocol: 'http' | 'socks5';
  host: string;
  destinationIP: string;
  port: number;
  chains: string[];
  start: number;
  meter: { uploaded(): number; downloaded(): number; upRate(): number; downRate(): number };
  close(): void;
}
