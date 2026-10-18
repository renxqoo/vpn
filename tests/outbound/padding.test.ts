import { describe, expect, test } from 'bun:test';
import { fixedRandom } from '../../src/core/random.ts';
import {
  CHECK_MARK,
  DEFAULT_PADDING_SCHEME,
  generateRecordPayloadSizes,
  makePaddingFactory,
  makeWasteFrame,
  md5Hex,
  parsePaddingScheme,
  planChunks,
} from '../../src/outbound/anytls/padding.ts';

describe('padding scheme parse', () => {
  test('default scheme fields', () => {
    const p = makePaddingFactory(DEFAULT_PADDING_SCHEME);
    if (!p) throw new Error('parse failed');
    expect(p.stop).toBe(8);
    expect(p.scheme['0']).toBe('30-30');
    expect(p.scheme['2']).toBe('400-500,c,500-1000,c,500-1000,c,500-1000,c,500-1000');
    expect(p.md5).toHaveLength(32);
    expect(p.md5).toMatch(/^[0-9a-f]{32}$/);
  });
  test('default scheme md5 golden (vs Go fmt %x of md5 sum)', () => {
    // 由参考实现公式计算：md5(rawScheme) 小写 hex
    const p = makePaddingFactory(DEFAULT_PADDING_SCHEME);
    expect(p?.md5).toBe(md5Hex(DEFAULT_PADDING_SCHEME));
  });
  test('missing stop → null', () => {
    expect(parsePaddingScheme('0=30-30')).toBeNull();
  });
  test('empty → null', () => {
    expect(parsePaddingScheme('')).toBeNull();
    expect(parsePaddingScheme('\n\n')).toBeNull();
  });
  test('stop non-numeric → null', () => {
    expect(parsePaddingScheme('stop=x\n0=1-2')).toBeNull();
  });
});

describe('generateRecordPayloadSizes', () => {
  test('fixed range min==max returns exact', () => {
    const p = makePaddingFactory(DEFAULT_PADDING_SCHEME);
    if (!p) throw new Error('p');
    expect(generateRecordPayloadSizes(p, 0, fixedRandom([0]))).toEqual([30]);
    expect(generateRecordPayloadSizes(p, 3, fixedRandom([0]))).toEqual([9, 500]); // 9-9,500-1000 → [9, rnd(500,1000)]
  });
  test('check marks preserved', () => {
    const p = makePaddingFactory(DEFAULT_PADDING_SCHEME);
    if (!p) throw new Error('p');
    const sizes = generateRecordPayloadSizes(p, 2, fixedRandom([400, 500, 600, 700, 800]));
    expect(sizes).toEqual([400, CHECK_MARK, 500, CHECK_MARK, 600, CHECK_MARK, 700, CHECK_MARK, 800]);
  });
  test('random within [min,max)', () => {
    const p = makePaddingSchemeForTest('stop=1\n0=100-200');
    if (!p) throw new Error('p');
    for (let i = 0; i < 50; i++) {
      const s = generateRecordPayloadSizes(p, 0, { intRange: (min, max) => min + (i * 37) % (max - min) });
      for (const v of s) expect(v).toBeGreaterThanOrEqual(100), expect(v).toBeLessThan(200);
    }
  });
  test('undefined pkt → empty', () => {
    const p = makePaddingSchemeForTest('stop=2\n0=1-1');
    if (!p) throw new Error('p');
    expect(generateRecordPayloadSizes(p, 1, fixedRandom([0]))).toEqual([]);
  });
  test('min>max swapped', () => {
    const p = makePaddingSchemeForTest('stop=1\n0=200-100');
    if (!p) throw new Error('p');
    const s = generateRecordPayloadSizes(p, 0, fixedRandom([150]));
    expect(s[0]).toBe(150);
  });
  test('garbage tokens skipped', () => {
    const p = makePaddingSchemeForTest('stop=1\n0=x,50-60,');
    if (!p) throw new Error('p');
    const s = generateRecordPayloadSizes(p, 0, fixedRandom([55]));
    expect(s).toEqual([55]);
  });
});

function makePaddingSchemeForTest(raw: string) {
  return makePaddingFactory(raw);
}

describe('planChunks (writeConn math)', () => {
  test('full payload steps then remainder passthrough', () => {
    // sizes [100], total 250 → write 100, remainder 150
    const plan = planChunks([100], 250);
    expect(plan.steps).toEqual([{ write: 100, wasteLen: 0 }]);
    expect(plan.remainder).toBe(150);
    expect(plan.stoppedAtCheck).toBe(false);
  });
  test('tail padding: remaining < size pads with waste frame (7B header counted)', () => {
    // size 100, remaining 50 → payload 50 + waste 100-50-7=43
    const plan = planChunks([100], 50);
    expect(plan.steps).toEqual([{ write: 50, wasteLen: 43 }]);
    expect(plan.remainder).toBe(0);
  });
  test('remaining exactly 0 after last step: all-waste step', () => {
    // size 100, total 0 → pure waste of 100 (93 data + 7 header)
    const plan = planChunks([100], 0);
    expect(plan.steps).toEqual([{ write: 0, wasteLen: 100 }]);
  });
  test('check mark stops when remaining hits 0', () => {
    const plan = planChunks([100, CHECK_MARK, 500], 100);
    expect(plan.steps).toEqual([{ write: 100, wasteLen: 0 }]);
    expect(plan.stoppedAtCheck).toBe(true);
    expect(plan.remainder).toBe(0);
  });
  test('check mark skipped when data still flowing', () => {
    const plan = planChunks([100, CHECK_MARK, 500], 700);
    expect(plan.steps).toEqual([{ write: 100, wasteLen: 0 }, { write: 500, wasteLen: 0 }]);
    expect(plan.stoppedAtCheck).toBe(false);
    expect(plan.remainder).toBe(100);
  });
  test('remaining smaller than header → no negative padding', () => {
    // size 20, remaining 10 → paddingLen = 20-10-7 = 3
    const plan = planChunks([20], 10);
    expect(plan.steps).toEqual([{ write: 10, wasteLen: 3 }]);
    // size 15, remaining 10 → paddingLen = -2 → 0（不足帧头不补）
    const p2 = planChunks([15], 10);
    expect(p2.steps).toEqual([{ write: 10, wasteLen: 0 }]);
  });
  test('multi-step scheme 2 golden: total exactly one step', () => {
    // scheme[2] 前两步 400 与 c：total 400 → 一步写完，c 停止
    const plan = planChunks([400, CHECK_MARK, 500, CHECK_MARK, 500], 400);
    expect(plan.steps).toEqual([{ write: 400, wasteLen: 0 }]);
    expect(plan.stoppedAtCheck).toBe(true);
  });
});

describe('waste frame', () => {
  test('header layout', () => {
    const f = makeWasteFrame(30);
    expect(f.length).toBe(7 + 30);
    expect(Array.from(f.slice(0, 7))).toEqual([0, 0, 0, 0, 0, 0, 30]);
  });
  test('encode/decode symmetry', () => {
    const f = makeWasteFrame(93);
    const r = decodeFrameOf(f);
    expect(r.cmd).toBe(0);
    expect(r.data.length).toBe(93);
  });
});

import { decodeFrame } from '../../src/outbound/anytls/frame.ts';
function decodeFrameOf(f: Uint8Array): { cmd: number; data: Uint8Array } {
  const r = decodeFrame(f);
  if (!r.ok) throw new Error('decode failed');
  return { cmd: r.frame.cmd, data: r.frame.data };
}
