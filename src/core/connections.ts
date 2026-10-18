/** 活动连接台账（design.md §1.6/§2.5）：API /connections 与关闭。 */

import type { ConnectionInfo } from './types.ts';

export class ConnectionTracker {
  private conns = new Map<string, ConnectionInfo>();
  private sessionUp = 0;
  private sessionDown = 0;

  open(info: ConnectionInfo): void {
    this.conns.set(info.id, info);
  }

  close(id: string): boolean {
    const c = this.conns.get(id);
    if (!c) return false;
    this.sessionUp += c.meter.uploaded();
    this.sessionDown += c.meter.downloaded();
    this.conns.delete(id);
    c.close();
    return true;
  }

  /** 快照视图（事件循环单线程下天然一致） */
  snapshot(): ConnectionInfo[] {
    return [...this.conns.values()];
  }

  get(id: string): ConnectionInfo | undefined {
    return this.conns.get(id);
  }

  /** 会话累计（含已关闭连接） */
  sessionTotals(): { upload: number; download: number } {
    let liveUp = 0;
    let liveDown = 0;
    for (const c of this.conns.values()) {
      liveUp += c.meter.uploaded();
      liveDown += c.meter.downloaded();
    }
    return { upload: this.sessionUp + liveUp, download: this.sessionDown + liveDown };
  }
}
