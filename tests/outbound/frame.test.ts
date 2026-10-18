import { describe, expect, test } from 'bun:test';
import { CMD, decodeFrame, decodeStringMap, encodeFrame, encodeStringMap } from '../../src/outbound/anytls/frame.ts';

describe('frame encode', () => {
  test('header-only frame bytes exact', () => {
    const enc = encodeFrame(CMD.syn, 0x01020304);
    expect(Array.from(enc)).toEqual([CMD.syn, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00]);
    expect(enc.length).toBe(7);
  });
  test('psh with data', () => {
    const enc = encodeFrame(CMD.psh, 7, new Uint8Array([1, 2, 3]));
    expect(Array.from(enc)).toEqual([CMD.psh, 0, 0, 0, 7, 0, 3, 1, 2, 3]);
  });
  test('max data 65535 ok, 65536 throws', () => {
    expect(encodeFrame(CMD.psh, 1, new Uint8Array(65535)).length).toBe(65535 + 7);
    expect(() => encodeFrame(CMD.psh, 1, new Uint8Array(65536))).toThrow();
  });
  test('all commands encode with cmd byte preserved', () => {
    for (const c of Object.values(CMD)) {
      expect(encodeFrame(c, 0)[0]).toBe(c);
    }
  });
});

describe('frame decode', () => {
  test('roundtrip all cmds with data', () => {
    for (const c of Object.values(CMD)) {
      const data = new Uint8Array([c, 255, 0]);
      const enc = encodeFrame(c, 42, data);
      const r = decodeFrame(enc);
      if (!r.ok) throw new Error('expected ok');
      expect(r.frame.cmd).toBe(c);
      expect(r.frame.sid).toBe(42);
      expect(Array.from(r.frame.data)).toEqual(Array.from(data));
      expect(r.consumed).toBe(enc.length);
    }
  });
  test('half packet reports need', () => {
    const enc = encodeFrame(CMD.psh, 1, new Uint8Array(100));
    const r = decodeFrame(enc.subarray(0, 50));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.need).toBe(107 - 50);
  });
  test('two frames concatenated decode in sequence', () => {
    const a = encodeFrame(CMD.settings, 0, encodeStringMap({ v: '2' }));
    const b = encodeFrame(CMD.psh, 9, new Uint8Array([5]));
    const both = new Uint8Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    const r1 = decodeFrame(both, 0);
    if (!r1.ok) throw new Error('r1');
    const r2 = decodeFrame(both, r1.consumed);
    if (!r2.ok) throw new Error('r2');
    expect(r2.frame.cmd).toBe(CMD.psh);
    expect(r2.frame.sid).toBe(9);
    expect(r1.consumed + r2.consumed).toBe(both.length);
  });
  test('zero-length data frame', () => {
    const enc = encodeFrame(CMD.fin, 3);
    const r = decodeFrame(enc);
    if (!r.ok) throw new Error('ok');
    expect(r.frame.data.length).toBe(0);
  });
});

describe('string map line protocol', () => {
  test('roundtrip', () => {
    const m = { v: '2', client: 'bunclash/1.0.0', 'padding-md5': 'abc123' };
    const back = decodeStringMap(encodeStringMap(m));
    expect(back).toEqual(m);
  });
  test('value with = is preserved', () => {
    const back = decodeStringMap(encodeStringMap({ k: 'a=b' }));
    expect(back['k']).toBe('a=b');
  });
  test('garbage lines skipped', () => {
    expect(decodeStringMap(new TextEncoder().encode('novalue\nk=v'))).toEqual({ k: 'v' });
  });
});
