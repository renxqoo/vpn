/**
 * Padding scheme 引擎（design.md §1.4；对齐 anytls-go padding.go + session.writeConn）。
 * 纯函数 + 随机源注入。
 */

import type { RandomSource } from '../../core/random.ts';
import { CMD, HEADER_SIZE } from './frame.ts';

export const CHECK_MARK = -1;

/** 默认 scheme（协议文档原文） */
export const DEFAULT_PADDING_SCHEME = `stop=8
0=30-30
1=100-400
2=400-500,c,500-1000,c,500-1000,c,500-1000,c,500-1000
3=9-9,500-1000
4=500-1000
5=500-1000
6=500-1000
7=500-1000`;

export interface PaddingFactory {
  rawScheme: string;
  md5: string;
  stop: number;
  scheme: Record<string, string>;
}

export function md5Hex(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher('md5');
  hasher.update(input);
  return hasher.digest('hex');
}

/** 单个 padding 帧数据的协议上界（u16 长度字段） */
export const MAX_PADDING_CHUNK = 0xffff;

/** 解析 scheme；缺 stop 或空 → null；任一尺寸超出协议界 → null（服务端可控输入的防护） */
export function parsePaddingScheme(raw: string): PaddingFactory | null {
  const scheme: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) scheme[line.slice(0, idx)] = line.slice(idx + 1);
  }
  if (Object.keys(scheme).length === 0) return null;
  const stop = Number(scheme['stop']);
  if (!Number.isInteger(stop) || stop < 0) return null;
  for (const def of Object.values(scheme)) {
    for (const part of def.split(',')) {
      if (part === 'c') continue;
      const dash = part.indexOf('-');
      if (dash < 0) continue;
      const min = Number(part.slice(0, dash));
      const max = Number(part.slice(dash + 1));
      if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
      if (min < 0 || max < 0 || min > MAX_PADDING_CHUNK || max > MAX_PADDING_CHUNK) return null;
    }
  }
  return { rawScheme: raw, md5: '', stop, scheme };
}

/** 初始化 md5；parsePaddingScheme 的补全形式（同步，CryptoHasher） */
export function makePaddingFactory(raw: string): PaddingFactory | null {
  const p = parsePaddingScheme(raw);
  if (!p) return null;
  p.md5 = md5Hex(raw);
  return p;
}

/** pkt 的分包尺寸列表（-1 = 检查标记）；无定义 → 空数组 */
export function generateRecordPayloadSizes(p: PaddingFactory, pkt: number, rnd: RandomSource): number[] {
  const def = p.scheme[String(pkt)];
  if (def === undefined) return [];
  const sizes: number[] = [];
  for (const part of def.split(',')) {
    if (part === 'c') {
      sizes.push(CHECK_MARK);
      continue;
    }
    const dash = part.indexOf('-');
    if (dash < 0) continue;
    let min = Number(part.slice(0, dash));
    let max = Number(part.slice(dash + 1));
    if (!Number.isInteger(min) || !Number.isInteger(max)) continue;
    if (min > max) [min, max] = [max, min];
    if (min <= 0 || max <= 0) continue;
    if (min === max) sizes.push(min);
    else sizes.push(rnd.intRange(min, max));
  }
  return sizes;
}

/**
 * writeConn 的分包计划（对齐 session.writeConn 的循环体，纯函数提取便于表驱动）。
 * 输入：尺寸列表（含 CHECK_MARK）、待写字节总长（含帧头）；
 * 输出：每次 socket.write 的字节数序列（-1 表示该次带 cmdWaste 补齐——调用方需要构帧），
 * 以及是否在 CHECK_MARK 处提前停止。
 */
export interface ChunkPlan {
  /** 每步：写入的字节数；若该步需要补 waste（write < 计划尺寸），wasteLen = 计划-帧头-写入 */
  steps: { write: number; wasteLen: number }[];
  stoppedAtCheck: boolean;
  /** 计划步数走完后剩余未处理的字节数（直发） */
  remainder: number;
}

export function planChunks(sizes: number[], totalLen: number): ChunkPlan {
  sizes = sizes.map((n) => (n > MAX_PADDING_CHUNK ? MAX_PADDING_CHUNK : n));
  const steps: ChunkPlan['steps'] = [];
  let remaining = totalLen;
  let stoppedAtCheck = false;
  for (const size of sizes) {
    if (size === CHECK_MARK) {
      if (remaining === 0) {
        stoppedAtCheck = true;
        break;
      }
      continue;
    }
    if (remaining > size) {
      // 整包 payload
      steps.push({ write: size, wasteLen: 0 });
      remaining -= size;
    } else if (remaining > 0) {
      // 尾包：payload + waste 补齐（计划尺寸含 7 字节帧头）
      const paddingLen = size - remaining - HEADER_SIZE;
      steps.push({ write: remaining, wasteLen: paddingLen > 0 ? paddingLen : 0 });
      remaining = 0;
    } else {
      // 用户数据已尽：全 waste 帧（尺寸含帧头）
      steps.push({ write: 0, wasteLen: size });
    }
  }
  return { steps, stoppedAtCheck, remainder: remaining };
}

/** 构造 cmdWaste 帧字节；len 超出协议 u16 界即抛（调用侧 planChunks 已钳制） */
export function makeWasteFrame(len: number): Uint8Array {
  if (len < 0 || len > MAX_PADDING_CHUNK) {
    throw new Error(`waste frame length out of range: ${len}`);
  }
  const out = new Uint8Array(HEADER_SIZE + len);
  out[0] = CMD.waste;
  const dv = new DataView(out.buffer);
  dv.setUint32(1, 0, false);
  dv.setUint16(5, len, false);
  return out;
}
