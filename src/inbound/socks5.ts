/**
 * SOCKS5 入站（design.md §1.3）：no-auth + CONNECT；UDP 拒绝；恶意流防越界。
 */

import { logger } from '../core/log.ts';
import { isIpv4, type SocksAddr } from '../core/socksaddr.ts';
import type { Conn, Outbound, Router } from '../core/types.ts';
import { MeteredPipe } from '../core/meter.ts';

const log = logger('inbound:socks5');
const MAX_GREETING = 257 + 8;
const HANDSHAKE_TIMEOUT = 30_000;

function withIdleTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('idle timeout')), ms)),
  ]);
}
const MAX_EARLY = 256 * 1024;

interface ClientState {
  phase: 'greeting' | 'request' | 'connecting' | 'tunnel';
  buf: Uint8Array;
  upstream: (Conn & { uploaded?(): number; downloaded?(): number; upRate?(): number; downRate?(): number }) | null;
  connId: string;
}

export interface Socks5InboundOptions {
  port: number;
  router: Router;
  outboundOf(name: string): Outbound | undefined;
  onOpen?(info: {
    id: string;
    host: string;
    port: number;
    chain: string[];
    meter: { uploaded(): number; downloaded(): number; upRate(): number; downRate(): number };
    close(): void;
  }): void;
  onClose?(id: string): void;
}

export class Socks5Inbound {
  private opts: Socks5InboundOptions;
  private listener: Bun.TCPSocketListener<undefined> | null = null;
  port = 0;

  constructor(opts: Socks5InboundOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.listener = Bun.listen({
      hostname: '127.0.0.1',
      port: this.opts.port,
      socket: this.handler(),
    });
    this.port = this.listener.port;
    log.info(`socks5 inbound on 127.0.0.1:${this.port}`);
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }

  private handler(): Bun.SocketHandler<undefined> {
    const { router, outboundOf, onOpen, onClose } = this.opts;

    return {
      open(socket) {
        (socket as unknown as { hsTimer?: ReturnType<typeof setTimeout> }).hsTimer = setTimeout(() => {
          socket.end();
        }, HANDSHAKE_TIMEOUT);
        const st: ClientState = {
          phase: 'greeting',
          buf: new Uint8Array(0),
          upstream: null,
          connId: crypto.randomUUID(),
        };
        (socket.data as unknown as ClientState) = st;
      },
      data(socket, chunk) {
        const st = socket.data as unknown as ClientState;
        if (st.phase === 'tunnel') {
          st.upstream?.write(chunk as Buffer).catch(() => socket.end());
          return;
        }
        if (st.phase === 'connecting') {
          // 握手后、上游建立前的早期数据：缓冲（establish 成功后 flush）
          const merged = new Uint8Array(st.buf.length + chunk.byteLength);
          merged.set(st.buf);
          merged.set(chunk as Buffer, st.buf.length);
          st.buf = merged;
          if (st.buf.length > MAX_EARLY) {
            socket.end();
          }
          return;
        }
        const merged = new Uint8Array(st.buf.length + chunk.byteLength);
        merged.set(st.buf);
        merged.set(chunk as Buffer, st.buf.length);
        st.buf = merged;
        if (st.buf.length > MAX_GREETING + 4096) {
          socket.end();
          return;
        }
        if (st.phase === 'greeting') {
          // VER NMETHODS METHODS...
          if (st.buf.length < 2) return;
          const ver = st.buf[0] as number;
          const nmethods = st.buf[1] as number;
          if (ver !== 5 || nmethods === 0) {
            socket.end(new Uint8Array([5, 0xff]));
            return;
          }
          if (st.buf.length < 2 + nmethods) return;
          const methods = st.buf.subarray(2, 2 + nmethods);
          if (!methods.includes(0)) {
            socket.end(new Uint8Array([5, 0xff]));
            return;
          }
          socket.write(new Uint8Array([5, 0]));
          st.buf = st.buf.subarray(2 + nmethods);
          st.phase = 'request';
        }
        if (st.phase === 'request') {
          const parsed = parseRequest(st.buf);
          if (parsed === 'need-more') return;
          if (parsed === 'bad') {
            socket.write(new Uint8Array([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
            socket.end();
            return;
          }
          const { cmd, addr } = parsed;
          if (cmd !== 1) {
            // UDP ASSOCIATE / BIND 不支持
            socket.write(new Uint8Array([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
            socket.end();
            return;
          }
          st.phase = 'connecting';
          st.buf = new Uint8Array(0);
          void establish(socket, st, addr);
        }
      },
      close(socket) {
        const st = socket.data as unknown as ClientState;
        st.upstream?.close();
        onClose?.(st.connId);
      },
      error() {},
    };

    function clearHandshakeTimer(sock: Bun.Socket<undefined>): void {
      const holder = sock as unknown as { hsTimer?: ReturnType<typeof setTimeout> };
      if (holder.hsTimer) {
        clearTimeout(holder.hsTimer);
        holder.hsTimer = undefined;
      }
    }

    async function establish(socket: Bun.Socket<undefined>, st: ClientState, addr: SocksAddr): Promise<void> {
      const host = addr.host.toLowerCase();
      const decision = router.resolve({ host, port: addr.port, isIp: addr.type !== 'fqdn' });
      if ('reject' in decision && decision.reject) {
        socket.write(new Uint8Array([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.end();
        return;
      }
      const name = 'outbound' in decision ? decision.outbound : 'DIRECT';
      const outbound = outboundOf(name);
      if (!outbound) {
        socket.write(new Uint8Array([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.end();
        return;
      }
      let upstream: Conn;
      try {
        upstream = await outbound.connect(addr);
      } catch (_e) {
        socket.write(new Uint8Array([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.end();
        return;
      }
      clearHandshakeTimer(socket);
      const metered = new MeteredPipe(upstream);
      const meteredConn = Object.assign(metered, {
        closed: upstream.closed,
        close: () => upstream.close(),
      });
      st.upstream = meteredConn;
      // BND.ADDR 0.0.0.0:0
      socket.write(new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      if (st.buf.length > 0) {
        const early = st.buf;
        st.buf = new Uint8Array(0);
        meteredConn.write(early).catch(() => socket.end());
      }
      st.phase = 'tunnel';
      onOpen?.({
        id: st.connId,
        host,
        port: addr.port,
        chain: [outbound.name],
        meter: meteredConn,
        close: () => socket.end(),
      });
      // 上游 → 客户端（经 meter 计量；空闲超时防静默上游）
      void (async () => {
        try {
          for (;;) {
            const chunk = await withIdleTimeout(st.upstream!.read(65536), 120_000);
            socket.write(chunk);
          }
        } catch (_e) {
          socket.end();
        }
      })();
    }
  }
}

type RequestParse =
  | { cmd: number; addr: SocksAddr }
  | 'need-more'
  | 'bad';

function parseRequest(buf: Uint8Array): RequestParse {
  // VER CMD RSV ATYP DST.ADDR DST.PORT
  if (buf.length < 4) return 'need-more';
  const ver = buf[0] as number;
  const cmd = buf[1] as number;
  if (ver !== 5) return 'bad';
  const atyp = buf[3] as number;
  if (atyp === 1) {
    if (buf.length < 4 + 4 + 2) return 'need-more';
    const host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    const port = (new DataView(buf.buffer, buf.byteOffset).getUint16(8, false)) as number;
    return { cmd, addr: { type: 'ipv4', host, port } };
  }
  if (atyp === 3) {
    const len = buf[4] as number | undefined;
    if (len === undefined) return 'need-more';
    if (len === 0) return 'bad';
    if (buf.length < 5 + len + 2) return 'need-more';
    const host = new TextDecoder().decode(buf.subarray(5, 5 + len));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const port = dv.getUint16(5 + len, false);
    return { cmd, addr: { type: 'fqdn', host, port } };
  }
  if (atyp === 4) {
    if (buf.length < 4 + 16 + 2) return 'need-more';
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((buf[4 + i] as number) << 8 | (buf[5 + i] as number)).toString(16));
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const port = dv.getUint16(20, false);
    return { cmd, addr: { type: 'ipv6', host: parts.join(':'), port } };
  }
  return 'bad';
}
