/** AnyTLS 帧编解码（design.md §1.4；对齐 anytls-go frame.go）。纯函数。 */

export const CMD = {
  waste: 0,
  syn: 1,
  psh: 2,
  fin: 3,
  settings: 4,
  alert: 5,
  updatePaddingScheme: 6,
  synack: 7,
  heartRequest: 8,
  heartResponse: 9,
  serverSettings: 10,
} as const;

export type Cmd = (typeof CMD)[keyof typeof CMD];

export const HEADER_SIZE = 7; // 1 cmd + 4 streamId + 2 len
export const MAX_DATA = 0xffff;

export interface Frame {
  cmd: number;
  sid: number;
  data: Uint8Array;
}

/** 编码帧；data ≤ 65535 否则抛错 */
export function encodeFrame(cmd: number, sid: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (data.length > MAX_DATA) throw new Error(`frame data too large: ${data.length}`);
  if (sid < 0 || sid > 0xffffffff) throw new Error(`invalid sid ${sid}`);
  const out = new Uint8Array(HEADER_SIZE + data.length);
  out[0] = cmd;
  const dv = new DataView(out.buffer);
  dv.setUint32(1, sid, false);
  dv.setUint16(5, data.length, false);
  out.set(data, HEADER_SIZE);
  return out;
}

export type DecodeResult =
  | { ok: true; frame: Frame; consumed: number }
  | { ok: false; need: number } // 还差多少字节（半包）
  ;

export function decodeFrame(buf: Uint8Array, offset = 0): DecodeResult {
  if (buf.length - offset < HEADER_SIZE) {
    return { ok: false, need: HEADER_SIZE - (buf.length - offset) };
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const cmd = buf[offset] as number;
  const sid = dv.getUint32(offset + 1, false);
  const len = dv.getUint16(offset + 5, false);
  const total = HEADER_SIZE + len;
  if (buf.length - offset < total) {
    return { ok: false, need: total - (buf.length - offset) };
  }
  return {
    ok: true,
    frame: { cmd, sid, data: buf.subarray(offset + HEADER_SIZE, offset + total) },
    consumed: total,
  };
}

/** k=v\n 行协议（对齐 anytls-go util/string_map.go：无尾随换行、无序） */
export function encodeStringMap(map: Record<string, string>): Uint8Array {
  const lines = Object.entries(map).map(([k, v]) => `${k}=${v}`);
  return new TextEncoder().encode(lines.join('\n'));
}

export function decodeStringMap(data: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(data);
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}
