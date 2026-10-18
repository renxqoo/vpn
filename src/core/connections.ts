/** 活动连接台账（design.md §1.6/§2.5）：API /connections 与关闭。 */

import type { ConnectionInfo } from './types.ts';

export class ConnectionTracker {
  private conns = new Map<string, ConnectionInfo>();

  open(info: ConnectionInfo): void {
    this.conns.set(info.id, info);
  }

  close(id: string): boolean {
    const c = this.conns.get(id);
    if (!c) return false;
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
}
