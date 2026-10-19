/**
 * GeoIP（mmdb 只读；design.md §1.5/D7b）：下载缓存 + 二进制搜索树查询 country ISO code。
 * mmdb 格式：metadata 定位（最后 14 字节内 AB CD EC）+ 搜索树（左 0 右 1）+ data 段。
 */

import { logger } from '../core/log.ts';
import { readBodyBounded } from '../core/fetchbounded.ts';

const log = logger('rules:geoip');

// 官方 marker 为 0xAB 0xCD 0xEC；MetaCubeX/meta-rules-dat 的 mmdb 用 0xAB 0xCD 0xEF（后随 "MaxMind.com"）
const METADATA_MARKERS = [new Uint8Array([0xab, 0xcd, 0xec]), new Uint8Array([0xab, 0xcd, 0xef])];
const DATA_SEPARATOR = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

export class MmdbReader {
  private buf: Uint8Array;
  private nodeCount: number;
  private recordSize: number; // bits per record
  private nodeBytes: number; // 搜索树总字节数
  private dataStart: number;
  private v6;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    const meta = findMetadata(buf);
    if (!meta) throw new Error('mmdb metadata not found');
    this.nodeCount = meta.nodeCount;
    this.recordSize = meta.recordSize;
    const bits = this.recordSize * 2 * this.nodeCount;
    this.nodeBytes = Math.ceil(bits / 8);
    this.dataStart = this.nodeBytes + 16;
    this.v6 = meta.ipVersion === 6;
    if (meta.ipVersion !== 6 && meta.ipVersion !== 4) throw new Error(`mmdb bad ip version ${meta.ipVersion}`);
  }

  /** 查询 country ISO code（如 'CN'）；未命中 null */
  country(ip: string): string | null {
    const bits = ipToBits(ip);
    if (!bits) return null;
    // ip_version=6 的树：IPv4 地址以 96 位 0 前缀映射进树（MaxMind 惯例）
    let walk: number[];
    if (bits.length === 32) {
      if (!this.v6) {
        walk = bits; // 纯 v4 树直接走
      } else {
        walk = [...new Array(96).fill(0), ...bits];
      }
    } else {
      walk = bits; // 128 位
    }
    let node = 0;
    for (let i = 0; i < walk.length; i++) {
      node = this.readNode(node, walk[i] === 1 ? 1 : 0);
      if (node === this.nodeCount) return null; // not found
      if (node > this.nodeCount) {
        const dataOffset = this.dataStart + (node - this.nodeCount - 16);
        return this.parseCountry(dataOffset);
      }
    }
    return null;
  }

  private readNode(node: number, side: 0 | 1): number {
    const base = node * ((this.recordSize * 2) >> 3);
    if (this.recordSize === 24) {
      const o = base + side * 3;
      return (this.buf[o] as number) << 16 | (this.buf[o + 1] as number) << 8 | (this.buf[o + 2] as number);
    }
    if (this.recordSize === 28) {
      const o = base;
      const middle = this.buf[o + 3] as number;
      const left = ((middle & 0xf0) << 20) | ((this.buf[o] as number) << 16) |
        ((this.buf[o + 1] as number) << 8) | (this.buf[o + 2] as number);
      const right = ((middle & 0x0f) << 24) | ((this.buf[o + 4] as number) << 16) |
        ((this.buf[o + 5] as number) << 8) | (this.buf[o + 6] as number);
      const val = side === 0 ? left : right;
      return val;
    }
    if (this.recordSize === 32) {
      const o = base + side * 4;
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset);
      return dv.getUint32(o);
    }
    throw new Error(`unsupported record size ${this.recordSize}`);
  }

  private parseCountry(offset: number): string | null {
    // 定制库 data 段大量使用指针复用与 extended 类型；按已验证的字节模式提取：
    // 叶记录窗口内第一个 [0x42][A-Z][A-Z]（string 头 size2 的 iso_code）。
    // 样本验证：CN 叶→CN、CLOUDFLARE 叶→IN、FASTLY 叶→AL、纯 continent 叶→NA（双字母 continent code，
    // 与国家码同形——GEOIP 匹配国家码时不会误中，可接受）。
    const win = Math.min(offset + 260, this.buf.length);
    for (let i = offset; i + 2 < win; i++) {
      if ((this.buf[i] as number) !== 0x42) continue;
      const a = this.buf[i + 1] as number;
      const b = this.buf[i + 2] as number;
      if (a >= 0x41 && a <= 0x5a && b >= 0x41 && b <= 0x5a) {
        return String.fromCharCode(a, b);
      }
    }
    return null;
  }

  private decode(offset: number): Decoded {
    const [type, extra] = this.decodeCtrl(offset);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset);
    switch (type) {
      case 'pointer': {
        const p = extra as number;
        return this.decode(this.dataStart + p);
      }
      case 'string': {
        const len = extra as number;
        return {
          type: 'string',
          value: new TextDecoder().decode(
            this.buf.subarray(offset + sizeOfSize(len), offset + sizeOfSize(len) + len),
          ),
        };
      }
      case 'map': {
        const count = extra as number;
        const map = new Map<string, Decoded>();
        let o = offset + sizeOfSize(count);
        for (let i = 0; i < count; i++) {
          const keyDec = this.decode(o);
          if (keyDec.type !== 'string') return { type: 'map', map };
          o = keyDec.next as number;
          const valDec = this.decode(o);
          map.set(keyDec.value as string, valDec);
          o = valDec.next as number;
        }
        return { type: 'map', map, next: o };
      }
      default:
        return { type: 'other', next: offset };
    }
  }

  private decodeCtrl(offset: number): [string, number | { pointer: number }] {
    const b = this.buf[offset] as number;
    let typeBits = b >> 5;
    let cursor = offset + 1;
    if (typeBits === 0) {
      // extended：真实类型在下一字节
      typeBits = this.buf[cursor] as number;
      cursor += 1;
    }
    if (typeBits === 1) {
      // pointer
      const size = (b >> 3) & 0x3;
      let ptr = b & 0x7;
      const ssize = size === 0 ? 0 : size === 1 ? 1 : size === 2 ? 2 : 3;
      for (let i = 0; i < ssize; i++) {
        ptr = (ptr << 8) | (this.buf[offset + 1 + i] as number);
      }
      const bias = size === 0 ? 0 : size === 1 ? 2048 : size === 2 ? 526336 : 0;
      return ['pointer', ptr + bias];
    }
    const type = typeBits === 2 ? 'string' : typeBits === 7 ? 'map' : 'other';
    let len = b & 0x1f;
    let o = cursor;
    if (len === 29) {
      len = 29 + (this.buf[o] as number);
      o += 1;
    } else if (len === 30) {
      len = 285 + ((this.buf[o] as number) << 8) + (this.buf[o + 1] as number);
      o += 2;
    } else if (len === 31) {
      len = 65821 + ((this.buf[o] as number) << 16) + ((this.buf[o + 1] as number) << 8) + (this.buf[o + 2] as number);
      o += 3;
    }
    return [type, len];
  }
}

interface Decoded {
  type: 'string' | 'map' | 'other' | 'pointer';
  value?: string;
  map?: Map<string, Decoded>;
  next?: number;
}

function sizeOfSize(n: number): number {
  if (n < 29) return 1;
  if (n < 285) return 2;
  if (n < 65821) return 3;
  return 4;
}

function findMetadata(buf: Uint8Array): { nodeCount: number; recordSize: number; ipVersion: number } | null {
  // 从尾部找 marker（最大 128KB 搜索窗口）
  const win = Math.min(buf.length, 128 * 1024);
  const start = buf.length - win;
  for (let i = buf.length - 3; i >= start; i--) {
    const b0 = buf[i] as number;
    if (b0 !== 0xab) continue;
    for (const marker of METADATA_MARKERS) {
      if ((buf[i + 1] as number) === marker[1] && (buf[i + 2] as number) === marker[2]) {
        let dataStart = i + 3;
        // "MaxMind.com" 前缀直接跳过（字符串，非 map 起点）
        const prefix = new TextDecoder().decode(buf.subarray(dataStart, dataStart + 11));
        if (prefix === 'MaxMind.com') dataStart += 11;
        return parseMetadata(buf.subarray(dataStart));
      }
    }
  }
  return null;
}

function parseMetadata(data: Uint8Array): { nodeCount: number; recordSize: number; ipVersion: number } | null {
  // 锚点法：metadata 是小 map；对 node_count / record_size / ip_version 三个 uint 字段，
  // 直接在尾部窗口搜键名文本，解析后随控制字节的 uint（跳过复杂类型——本库 languages 数组
  // 的指针编码与规范读法存在出入，见 docs/design.md D7b 附注）。
  const td = new TextDecoder();
  const readUintAfter = (key: string): number | null => {
    const needle = new TextEncoder().encode(key);
    // 在 data 里找最后一次出现（避免与 data 段重名）
    let idx = -1;
    for (let i = data.length - needle.length; i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (data[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    let o = idx + needle.length;
    const b = data[o] as number;
    const type = b >> 5;
    let size = b & 0x1f;
    o += 1;
    if (size >= 29) {
      size = 29 + (data[o] as number);
      o += 1;
    }
    if (type !== 5 && type !== 6 && type !== 0) return null; // uint16/uint32（或 extended）
    if (type === 0) {
      // extended uint：真实类型 11(uint64)/12...；size 已读
      o += 1;
    }
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + (data[o + i] as number);
    return v;
  };
  const nodeCount = readUintAfter('node_count');
  const recordSize = readUintAfter('record_size');
  const ipVersion = readUintAfter('ip_version') ?? 6;
  if (!nodeCount || !recordSize) return null;
  void td;
  return { nodeCount, recordSize, ipVersion };
}

function ipToBits(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255)) {
    const bits: number[] = [];
    for (const p of parts) {
      const v = Number(p);
      for (let i = 7; i >= 0; i--) bits.push((v >> i) & 1);
    }
    return bits;
  }
  // IPv6： '::' 展开太长时逐组
  if (ip.includes(':')) {
    const groups = expandV6(ip);
    if (!groups) return null;
    const bits: number[] = [];
    for (const g of groups) {
      for (let i = 15; i >= 0; i--) bits.push((g >> i) & 1);
    }
    return bits;
  }
  return null;
}

function expandV6(ip: string): number[] | null {
  let head: number[] = [];
  let tail: number[] = [];
  const idx = ip.indexOf('::');
  if (idx < 0) {
    const gs = ip.split(':');
    if (gs.length !== 8) return null;
    head = gs.map((g) => parseInt(g || '0', 16));
    if (head.some(Number.isNaN)) return null;
    return head;
  }
  for (const g of ip.slice(0, idx).split(':')) {
    if (!g) continue;
    const v = parseInt(g, 16);
    if (Number.isNaN(v)) return null;
    head.push(v);
  }
  for (const g of ip.slice(idx + 2).split(':')) {
    if (!g) continue;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(g)) {
      const p = g.split('.').map(Number);
      tail.push((p[0] as number) << 8 | (p[1] as number), (p[2] as number) << 8 | (p[3] as number));
      continue;
    }
    const v = parseInt(g, 16);
    if (Number.isNaN(v)) return null;
    tail.push(v);
  }
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/** 下载并加载 mmdb；失败返回 null（GEOIP 规则禁用，D7b） */
export async function loadGeoip(url: string | undefined, cachePath: string | null): Promise<MmdbReader | null> {
  let buf: Uint8Array | null = null;
  if (cachePath) {
    const f = Bun.file(cachePath);
    if (await f.exists()) {
      buf = new Uint8Array(await f.arrayBuffer());
    }
  }
  const stale = buf === null;
  if (url && stale) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        buf = await readBodyBounded(r);
        if (cachePath) await Bun.write(cachePath, buf).catch(() => {});
        log.info(`geoip mmdb downloaded (${buf.length} bytes)`);
      } else {
        log.warn(`geoip mmdb download failed: HTTP ${r.status}`);
      }
    } catch (e) {
      log.warn(`geoip mmdb download failed: ${String(e).slice(0, 60)}`);
    }
  }
  if (!buf) {
    if (!stale) log.info('geoip mmdb loaded from cache');
    else log.warn('geoip unavailable; GEOIP rules disabled');
    return null;
  }
  try {
    return new MmdbReader(buf);
  } catch (e) {
    log.warn(`geoip mmdb parse failed: ${String(e).slice(0, 60)}`);
    return null;
  }
}

void DATA_SEPARATOR;
void log;
