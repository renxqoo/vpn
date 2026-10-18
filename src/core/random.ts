/** 时钟与随机注入（design.md §2 core/clock）：可测试性——单测用固定源。 */

export interface RandomSource {
  /** 返回 [min, max) 内整数（对齐 Go rand.Int(max)+min 语义） */
  intRange(min: number, max: number): number;
}

export const cryptoRandom: RandomSource = {
  intRange(min, max) {
    if (max <= min) return min;
    const span = max - min;
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    const v = new DataView(buf.buffer).getUint32(0);
    return min + (v % span);
  },
};

/** 固定序列随机源：按顺序返回预置值，耗尽后返回最后一个值 */
export function fixedRandom(values: number[]): RandomSource {
  let i = 0;
  return {
    intRange(min, max) {
      const v = values[Math.min(i, values.length - 1)] ?? min;
      i++;
      if (v < min) return min;
      if (v >= max) return max - 1;
      return v;
    },
  };
}
