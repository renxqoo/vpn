/**
 * AnyTLS 出站适配层（Clash 语义）：openStream → 写 SOCKSAddr → 双向隧道 Conn 视图。
 */

import type { SocksAddr } from '../../core/socksaddr.ts';
import type { Conn, Outbound } from '../../core/types.ts';
import { AnytlsClient } from './client.ts';
import { aggregateHealth, probeConnection, recordSample } from '../../core/health.ts';
import type { HealthSample, HealthSummary } from '../../core/health.ts';
import { AnytlsStream, EofError } from './session.ts';

class AnytlsConn implements Conn {
  private stream: AnytlsStream;
  private client: AnytlsClient;
  private done: Promise<void>;
  private closedFlag = false;

  constructor(stream: AnytlsStream, client: AnytlsClient, done: Promise<void>) {
    this.stream = stream;
    this.client = client;
    this.done = done;
  }

  static async open(client: AnytlsClient, target: SocksAddr): Promise<AnytlsConn> {
    const { stream, done } = await client.openStream();
    try {
      await stream.writeTarget(target);
    } catch (e) {
      stream.close();
      void done;
      throw e;
    }
    return new AnytlsConn(stream, client, done);
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  write(data: Uint8Array): Promise<number> {
    if (this.closedFlag) return Promise.reject(new Error('closed'));
    return this.stream.write(data);
  }

  async read(max = 65536): Promise<Uint8Array> {
    if (this.closedFlag) return Promise.reject(new Error('closed'));
    try {
      return await this.stream.read(max);
    } catch (e) {
      if (e instanceof EofError) throw new Error('eof');
      throw e;
    }
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.stream.close();
    void this.done;
    void this.client;
  }
}

export class AnytlsOutbound implements Outbound {
  readonly name: string;
  private client: AnytlsClient;
  private healthHistory: HealthSample[] = [];

  constructor(name: string, client: AnytlsClient) {
    this.name = name;
    this.client = client;
    client.startCleanup();
  }

  connect(target: SocksAddr): Promise<Conn> {
    return AnytlsConn.open(this.client, target);
  }

  /** 健康摘要（API/CLI 消费） */
  health(): HealthSummary {
    return aggregateHealth(this.healthHistory);
  }

  async probe(_url: string, timeoutMs: number, options?: { isolated?: boolean }): Promise<number | null> {
    const client = options?.isolated ? this.client.createProbeClient() : this.client;
    let delay: number | null;
    try { delay = await probeConnection({ connect: (target) => AnytlsConn.open(client, target) }, _url, timeoutMs); }
    finally { if (options?.isolated) client.close(); }
    this.healthHistory = recordSample(this.healthHistory, { at: Date.now(), delayMs: delay });
    return delay;
  }

  retire(onDrained: () => void): void {
    this.client.retire(onDrained);
  }

  close(): void {
    this.client.close();
  }

  get sessionStats(): { active: number; idle: number } {
    return { active: this.client.activeSessionCount(), idle: this.client.idleSessionCount() };
  }
}
