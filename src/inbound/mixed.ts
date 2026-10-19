/**
 * 混合端口入站（docs/mixed-port.md）：单端口首字节嗅探分流——0x05→SOCKS5，其余→HTTP。
 * 协议状态机完全复用 HttpInbound/Socks5Inbound 的既有 handler；
 * 嗅探状态经 WeakMap 外挂（socket.data 完全归协议层，不互踩）。
 */

import { logger } from '../core/log.ts';
import type { HttpInbound } from './http.ts';
import type { Socks5Inbound } from './socks5.ts';

const log = logger('inbound:mixed');
const HANDSHAKE_TIMEOUT = 30_000;

export interface MixedInboundOptions {
  port: number;
  http: HttpInbound;
  socks: Socks5Inbound;
}

/** 两协议 handler 的最小面（socket 语义类型不一致，统一经 unknown 衔接） */
type AnyHandler = {
  open?(socket: unknown): void;
  data(socket: unknown, chunk: Buffer | Uint8Array): void;
  close?(socket: unknown): void;
  error?(socket: unknown, err: Error): void;
};

type SniffState = { decided: AnyHandler | null; hsTimer?: ReturnType<typeof setTimeout> };
const sniffStates = new WeakMap<object, SniffState>();

/** 嗅探锚点：socket 身份键（socket.data 会被协议层复用，不能当键） */
const sniffKeys = new WeakMap<object, object>();

export class MixedInbound {
  private opts: MixedInboundOptions;
  private listener: Bun.TCPSocketListener<undefined> | null = null;
  port = 0;

  constructor(opts: MixedInboundOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const http = this.opts.http.handler() as unknown as AnyHandler;
    const socks = this.opts.socks.handler() as unknown as AnyHandler;
    const keyOf = (socket: Bun.Socket<undefined>): object => {
      const holder = socket as unknown as object;
      let key = sniffKeys.get(holder);
      if (!key) { key = {}; sniffKeys.set(holder, key); }
      return key;
    };
    this.listener = Bun.listen({
      hostname: '127.0.0.1',
      port: this.opts.port,
      socket: {
        open(socket) {
          const st: SniffState = { decided: null };
          sniffStates.set(keyOf(socket), st);
          st.hsTimer = setTimeout(() => socket.end(), HANDSHAKE_TIMEOUT);
        },
        data(socket, chunk) {
          const st = sniffStates.get(keyOf(socket));
          if (!st) return; // 理论不可达：open 必先于 data
          if (!st.decided) {
            if (st.hsTimer) { clearTimeout(st.hsTimer); st.hsTimer = undefined; }
            if (chunk.byteLength === 0) return;
            // 首字节 0x05 = SOCKS5 VER；HTTP 请求行是 ASCII 文本，不会以 0x05 开头
            st.decided = chunk[0] === 0x05 ? socks : http;
            st.decided.open?.(socket);
          }
          st.decided.data(socket, chunk);
        },
        close(socket) {
          const key = keyOf(socket);
          const st = sniffStates.get(key);
          if (st?.hsTimer) clearTimeout(st.hsTimer);
          if (st?.decided) st.decided.close?.(socket);
          sniffStates.delete(key);
        },
        error(socket, err) {
          const st = sniffStates.get(keyOf(socket));
          if (st?.hsTimer) clearTimeout(st.hsTimer);
          if (st?.decided) st.decided.error?.(socket, err);
        },
      },
    });
    this.port = this.listener.port;
    log.info(`mixed inbound on 127.0.0.1:${this.port} (http+socks5)`);
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}
