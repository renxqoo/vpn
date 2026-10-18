import { describe, expect, test } from 'bun:test';
import { MeteredPipe, TrafficMeter, rateOf } from '../../src/core/meter.ts';

describe('TrafficMeter：窗口计数', () => {
  test('空计量零速率', () => {
    const m = new TrafficMeter();
    expect(m.total()).toBe(0);
    expect(m.rate()).toBe(0);
  });

  test('累计与窗口速率', () => {
    const m = new TrafficMeter(1000, () => 1000);
    m.add(500);
    m.add(300);
    expect(m.total()).toBe(800);
    expect(m.rate()).toBeGreaterThan(0);
    expect(m.rate()).toBeLessThanOrEqual(16000);
  });

  test('速率随时间摊开下降（注入时钟）', () => {
    let now = 5000;
    const m = new TrafficMeter(10000, () => now);
    m.add(1000);
    const immediate = m.rate();
    now += 4000;
    const spread = m.rate();
    expect(spread).toBeLessThan(immediate);
    expect(spread).toBe(250);
  });

  test('窗口过期后速率归零、总量保留', async () => {
    const m = new TrafficMeter(50);
    m.add(1000);
    await new Promise((r) => setTimeout(r, 80));
    expect(m.rate()).toBe(0);
    expect(m.total()).toBe(1000);
  });

  test('rateOf 计算语义：字节/秒', () => {
    const now = 10000;
    expect(rateOf([], now, 1000)).toBe(0);
    const r = rateOf(
      [
        { at: now - 900, bytes: 400 },
        { at: now - 300, bytes: 500 },
      ],
      now,
      1000,
    );
    expect(r).toBe(1000);
    expect(rateOf([{ at: now - 5000, bytes: 999 }], now, 1000)).toBe(0);
  });
});

describe('MeteredPipe：透传包装', () => {
  test('read/write 都计量且不改变数据', async () => {
    let srcReads = 0;
    let totalGiven = 0;
    const upstream = {
      async read(max: number) {
        srcReads++;
        if (totalGiven > 0) throw new Error('eof');
        totalGiven = max;
        return new Uint8Array(max).fill(7);
      },
      async write(data: Uint8Array) {
        return data.length;
      },
    };
    const pipe = new MeteredPipe(upstream);
    const chunk = await pipe.read(1024);
    expect(chunk.length).toBe(1024);
    expect(chunk.every((b) => b === 7)).toBe(true);
    const n = await pipe.write(new Uint8Array(64).fill(1));
    expect(n).toBe(64);
    expect(pipe.uploaded()).toBe(64);
    expect(pipe.downloaded()).toBe(1024);
    expect(srcReads).toBe(1);
  });
});
