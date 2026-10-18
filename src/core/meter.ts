export interface Sample {
  at: number;
  bytes: number;
}

/** 滚动窗口字节计数：总量 + 窗口内速率 */
export class TrafficMeter {
  private samples: Sample[] = [];
  private sum = 0;
  private readonly windowMs: number;

  constructor(windowMs = 5000, private clock: () => number = () => Date.now()) {
    this.windowMs = windowMs;
  }

  add(bytes: number): void {
    if (bytes <= 0) return;
    this.sum += bytes;
    this.samples.push({ at: this.clock(), bytes });
    this.evict();
  }

  total(): number {
    return this.sum;
  }

  rate(): number {
    this.evict();
    return rateOf(this.samples, this.clock(), this.windowMs);
  }

  private evict(): void {
    const cutoff = this.clock() - this.windowMs;
    let drop = 0;
    for (const s of this.samples) {
      if (s.at < cutoff) drop++;
      else break;
    }
    if (drop > 0) this.samples = this.samples.slice(drop);
  }
}

/** 纯函数：窗口内字节 → 每秒速率（分母取窗口跨度，避免单样本瞬时虚高） */
export function rateOf(samples: Sample[], now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let bytes = 0;
  let earliest: number | null = null;
  for (const s of samples) {
    if (s.at < cutoff) continue;
    bytes += s.bytes;
    if (earliest === null || s.at < earliest) earliest = s.at;
  }
  if (bytes === 0 || earliest === null) return 0;
  const granularity = Math.max(Math.floor(windowMs / 10), 1);
  const spanMs = Math.max(now - earliest, granularity);
  return Math.round((bytes / spanMs) * 1000);
}

/** 连接级双向计量：包在真实 Conn 外，不改协议层 */
export class MeteredPipe {
  private up = new TrafficMeter();
  private down = new TrafficMeter();

  constructor(private inner: { read(max?: number): Promise<Uint8Array>; write(data: Uint8Array): Promise<number> }) {}

  async read(max = 65536): Promise<Uint8Array> {
    const chunk = await this.inner.read(max);
    this.down.add(chunk.length);
    return chunk;
  }

  async write(data: Uint8Array): Promise<number> {
    const n = await this.inner.write(data);
    this.up.add(n);
    return n;
  }

  uploaded(): number {
    return this.up.total();
  }

  downloaded(): number {
    return this.down.total();
  }

  upRate(): number {
    return this.up.rate();
  }

  downRate(): number {
    return this.down.rate();
  }
}
