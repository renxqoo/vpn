/** 直连出站。 */

import { isIpv4 } from '../core/socksaddr.ts';
import type { Conn, Outbound } from '../core/types.ts';
import type { SocksAddr } from '../core/socksaddr.ts';

class DirectConn implements Conn {
  private socket: Bun.Socket<undefined> | null;
  upload = 0;
  download = 0;
  private closedFlag = false;
  private recvBuf: Uint8Array[] = [];
  private waiters: ((ok: boolean) => void)[] = [];
  private eof = false;

  constructor(socket: Bun.Socket<undefined>) {
    this.socket = socket;
  }

  static async connect(target: SocksAddr): Promise<DirectConn> {
    let session: DirectConn | null = null;
    let openedResolve: (() => void) | null = null;
    let opened = false;
    const openedPromise = new Promise<void>((r) => (openedResolve = r));
    let dialTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      rejectDial(new Error('connect timeout'));
    }, 15000);
    let rejectDial: (e: Error) => void = () => {};
    const dialFailed = new Promise<never>((_, rej) => (rejectDial = rej));
    const socket = await Promise.race([
      Bun.connect({
        hostname: target.host,
        port: target.port,
        socket: {
        data(_s: Bun.Socket<undefined>, data: Buffer) {
          const conn = session;
          if (!conn) return;
          conn.recvBuf.push(new Uint8Array(data));
          for (const w of conn.waiters.splice(0)) w(true);
        },
        close() {
          const conn = session;
          if (!conn) return;
          conn.eof = true;
          for (const w of conn.waiters.splice(0)) w(false);
          conn.closedFlag = true;
        },
        end() {
          const conn = session;
          if (!conn) return;
          conn.eof = true;
          for (const w of conn.waiters.splice(0)) w(false);
        },
        error(_s: Bun.Socket<undefined>, err: Error) {
          const conn = session;
          if (!conn) return;
          conn.eof = true;
          for (const w of conn.waiters.splice(0)) w(false);
          void err;
        },
        open() {
          opened = true;
          openedResolve?.();
        },
      },
    } as unknown as Parameters<typeof Bun.connect>[0]),
      dialFailed,
    ]);
    if (dialTimer) clearTimeout(dialTimer);
    dialTimer = null;
    if (!opened) await openedPromise;
    openedResolve = null;
    session = new DirectConn(socket as Bun.Socket<undefined>);
    return session;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  write(data: Uint8Array): Promise<number> {
    const sock = this.socket;
    if (!sock || this.closedFlag) return Promise.reject(new Error('closed'));
    this.upload += data.length;
    const n = sock.write(data);
    if (n < 0) return Promise.reject(new Error('write failed'));
    return Promise.resolve(n);
  }

  read(max = 65536): Promise<Uint8Array> {
    if (this.recvBuf.length > 0) return Promise.resolve(this.take(max));
    if (this.eof) return Promise.reject(new Error('eof'));
    return new Promise((resolve, reject) => {
      this.waiters.push(() => {
        if (this.recvBuf.length > 0) resolve(this.take(max));
        else reject(new Error('eof'));
      });
    });
  }

  private take(max: number): Uint8Array {
    const out: Uint8Array[] = [];
    let taken = 0;
    while (this.recvBuf.length > 0 && taken < max) {
      const first = this.recvBuf[0] as Uint8Array;
      if (taken + first.length <= max) {
        out.push(first);
        taken += first.length;
        this.recvBuf.shift();
      } else {
        const need = max - taken;
        out.push(first.subarray(0, need));
        this.recvBuf[0] = first.subarray(need);
        taken = max;
      }
    }
    const merged = new Uint8Array(taken);
    let off = 0;
    for (const c of out) {
      merged.set(c, off);
      off += c.length;
    }
    this.download += taken;
    return merged;
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.eof = true;
    for (const w of this.waiters.splice(0)) w(false);
    try {
      this.socket?.end();
    } catch (_e) {
      /* noop */
    }
    this.socket = null;
  }
}

export class DirectOutbound implements Outbound {
  readonly name: string;

  constructor(name = 'DIRECT') {
    this.name = name;
  }

  async connect(target: SocksAddr): Promise<Conn> {
    // IP 目标直连；域名目标由 Bun 内置解析
    if (isIpv4(target.host) || target.host.includes(':')) {
      return DirectConn.connect({ ...target, type: target.type });
    }
    return DirectConn.connect(target);
  }

  close(): void {
    // 无状态
  }
}
