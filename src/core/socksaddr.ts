/**
 * SOCKSAddr 编解码（design.md §2 单一真相；RFC1928 §5 地址格式）。
 * 入站 SOCKS5 与 AnyTLS 出站共用，不双写。
 */

export type SocksAddr =
  | { type: 'ipv4'; host: string; port: number }
  | { type: 'ipv6'; host: string; port: number }
  | { type: 'fqdn'; host: string; port: number };

export class SocksAddrError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SocksAddrError';
  }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  if (!m) return false;
  return m.slice(1).every((p) => Number(p) <= 255);
}

function isIpv6(s: string): boolean {
  if (!s.includes(':')) return false;
  // 含非法字符直接否
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return false;
  // 简化校验：交给字节级解析验证
  try {
    return parseIpv6ToBytes(s) !== null;
  } catch (_e) {
    return false;
  }
}

export function parseIpv6ToBytes(s: string): Uint8Array | null {
  // 处理 :: 缩写与 IPv4 尾段
  let head: number[][] = [];
  let tail: number[][] = [];
  let side: 'head' | 'tail' = 'head';
  let v4tail: string | null = null;
  if (!s.includes('::')) {
    const groups = s.split(':');
    const all: number[][] = [];
    for (const g of groups) {
      if (IPV4_RE.test(g)) {
        v4tail = g;
        continue;
      }
      if (g === '') return null;
      const v = parseInt(g, 16);
      if (Number.isNaN(v) || v > 0xffff) return null;
      all.push([v >> 8, v & 0xff]);
    }
    if (all.length + (v4tail ? 2 : 0) !== 8) return null;
    if (v4tail) {
      const m = IPV4_RE.exec(v4tail);
      if (!m) return null;
      all.push([Number(m[1]), Number(m[2])]);
      all.push([Number(m[3]), Number(m[4])]);
    }
    return new Uint8Array(all.flat());
  }
  // 含 ::
  const idx = s.indexOf('::');
  if (s.indexOf('::', idx + 1) !== -1) return null; // 只允许一个 ::
  const left = s.slice(0, idx);
  const right = s.slice(idx + 2);
  for (const g of left.split(':')) {
    if (g === '') continue;
    if (IPV4_RE.test(g)) return null; // v4 只能出现在最尾
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v > 0xffff) return null;
    head.push([v >> 8, v & 0xff]);
  }
  for (const g of right.split(':')) {
    if (g === '') continue;
    if (IPV4_RE.test(g)) {
      v4tail = g;
      continue;
    }
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v > 0xffff) return null;
    tail.push([v >> 8, v & 0xff]);
  }
  if (v4tail) {
    const m = IPV4_RE.exec(v4tail);
    if (!m) return null;
    tail.push([Number(m[1]), Number(m[2])]);
    tail.push([Number(m[3]), Number(m[4])]);
  }
  const total = head.length + tail.length;
  if (total > 7) return null;
  const zeros = 8 - total;
  const out = [...head.flat(), ...new Array(zeros * 2).fill(0), ...tail.flat()];
  return new Uint8Array(out);
}

export function encodeSocksAddr(addr: SocksAddr): Uint8Array {
  const port = addr.port;
  if (port < 0 || port > 65535) throw new SocksAddrError(`invalid port ${port}`);
  let hostBytes: Uint8Array;
  let type: number;
  if (addr.type === 'fqdn') {
    const name = new TextEncoder().encode(addr.host);
    if (name.length === 0 || name.length > 255) throw new SocksAddrError(`fqdn length ${name.length}`);
    hostBytes = new Uint8Array(1 + name.length);
    hostBytes[0] = name.length;
    hostBytes.set(name, 1);
    type = 0x03;
  } else if (addr.type === 'ipv4') {
    if (!isIpv4(addr.host)) throw new SocksAddrError(`invalid ipv4 ${addr.host}`);
    hostBytes = new Uint8Array(4);
    const parts = addr.host.split('.').map(Number);
    hostBytes.set(parts);
    type = 0x01;
  } else {
    const b = parseIpv6ToBytes(addr.host);
    if (!b || b.length !== 16) throw new SocksAddrError(`invalid ipv6 ${addr.host}`);
    hostBytes = b;
    type = 0x04;
  }
  const out = new Uint8Array(1 + hostBytes.length + 2);
  out[0] = type;
  out.set(hostBytes, 1);
  const dv = new DataView(out.buffer);
  dv.setUint16(1 + hostBytes.length, port, false);
  return out;
}

/** 从 buf 的 offset 起解析一个 SOCKSAddr；返回 addr 与消费的字节数 */
export function decodeSocksAddr(buf: Uint8Array, offset = 0): { addr: SocksAddr; consumed: number } {
  if (offset >= buf.length) throw new SocksAddrError('truncated: no atyp byte');
  const atyp = buf[offset];
  if (atyp === 0x01) {
    if (offset + 1 + 4 + 2 > buf.length) throw new SocksAddrError('truncated ipv4');
    const host = `${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}.${buf[offset + 4]}`;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const port = dv.getUint16(offset + 5, false);
    return { addr: { type: 'ipv4', host, port }, consumed: 7 };
  }
  if (atyp === 0x03) {
    const len = buf[offset + 1];
    if (len === undefined) throw new SocksAddrError('truncated fqdn length');
    if (len === 0) throw new SocksAddrError('fqdn length 0');
    if (offset + 2 + len + 2 > buf.length) throw new SocksAddrError('truncated fqdn');
    const host = new TextDecoder().decode(buf.subarray(offset + 2, offset + 2 + len));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const port = dv.getUint16(offset + 2 + len, false);
    return { addr: { type: 'fqdn', host, port }, consumed: 2 + len + 2 };
  }
  if (atyp === 0x04) {
    if (offset + 1 + 16 + 2 > buf.length) throw new SocksAddrError('truncated ipv6');
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((buf[offset + 1 + i] as number) << 8 | (buf[offset + 2 + i] as number)).toString(16));
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const port = dv.getUint16(offset + 17, false);
    // IPv4 尾段还原仅限明确映射前缀：64:ff9b::/96（NAT64）与全零头 + 尾 2 组恰好是映射形式（::a.b.c.d 输入文本回环）
    // 全零头但尾组是常规单地址（如 ::1）不还原，走压缩格式
    const headAllZero = parts.slice(0, 6).every((g) => g === '0');
    const nat64 = parts[0] === '64' && parts[1] === 'ff9b' && parts.slice(2, 6).every((g) => g === '0');
    const v4Mapped = headAllZero && parts[6] !== '0' && parts[6] !== 'ffff';
    let host: string;
    if (nat64 || v4Mapped) {
      const b1 = parseInt(parts[6] as string, 16);
      const b2 = parseInt(parts[7] as string, 16);
      const v4 = `${(b1 >> 8) & 0xff}.${b1 & 0xff}.${(b2 >> 8) & 0xff}.${b2 & 0xff}`;
      host = nat64 ? `64:ff9b::${v4}` : `::${v4}`;
    } else {
      host = formatIpv6(parts.join(':'));
    }
    return { addr: { type: 'ipv6', host, port }, consumed: 19 };
  }
  const a = atyp as number;
  throw new SocksAddrError(`unknown atyp 0x${a.toString(16)}`);
}

/** 展开 IPv6 最长 0 段为 ::，段内前导零别剥到只剩空（每段至少 1 位） */
export function formatIpv6(raw: string): string {
  const groups = raw.split(':');
  const norm = groups.map((g) => {
    const stripped = g.replace(/^0+(?=.)/, '');
    return stripped === '' ? '0' : stripped;
  });
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  norm.forEach((g, i) => {
    if (g === '0') {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  });
  if (bestLen < 2) return norm.join(':');
  const head = norm.slice(0, bestStart).join(':');
  const tail = norm.slice(bestStart + bestLen).join(':');
  const joined = `${head}::${tail}`;
  return joined.replace(/::\+/, '::');
}
