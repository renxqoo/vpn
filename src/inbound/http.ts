/**
 * HTTP 代理入站（design.md §1.2）：CONNECT 隧道 + 绝对形式转发，逐请求路由。
 * 隧道态：客户端 socket data 直写上游 Conn；上游读循环回写客户端 socket。
 */

import { logger } from '../core/log.ts';
import { isIpv4, type SocksAddr } from '../core/socksaddr.ts';
import type { Conn, Outbound, Router } from '../core/types.ts';
import { MeteredPipe } from '../core/meter.ts';

const log = logger('inbound:http');
const HANDSHAKE_TIMEOUT = 30_000;
const MAX_HEADER = 256 * 1024;

function withIdleTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('idle timeout')), ms)),
  ]);
}

interface ClientState {
  buf: Uint8Array;
  tunnel: { upstream: Conn & MeteredPipe } | null;
  forwardUpstream: MeteredPipe | null;
  forwardedDone: boolean;
  connecting: boolean;
  connId: string;
}

export interface HttpInboundOptions {
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

export class HttpInbound {
  private opts: HttpInboundOptions;
  private listener: Bun.TCPSocketListener<undefined> | null = null;
  port = 0;

  constructor(opts: HttpInboundOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.listener = Bun.listen({
      hostname: '127.0.0.1',
      port: this.opts.port,
      socket: this.handler(),
    });
    this.port = this.listener.port;
    log.info(`http inbound on 127.0.0.1:${this.port}`);
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }

  private handler(): Bun.SocketHandler<undefined> {
    const { router, outboundOf, onOpen, onClose } = this.opts;

    function isIpHost(h: string): boolean {
      // v4 点分 / v6 冒号（CONNECT 的 host 已去括号）
      return isIpv4(h) || h.includes(':');
    }

    function pick(host: string, port: number): { outbound: Outbound } | { error: number } {
      const decision = router.resolve({ host, port, isIp: isIpHost(host) });
      if ('reject' in decision && decision.reject) return { error: 403 };
      const name = 'outbound' in decision ? decision.outbound : 'DIRECT';
      const outbound = outboundOf(name);
      if (!outbound) return { error: 502 };
      return { outbound };
    }

    return {
      open(socket) {
        (socket as unknown as { hsTimer?: ReturnType<typeof setTimeout> }).hsTimer = setTimeout(() => {
          socket.end();
        }, HANDSHAKE_TIMEOUT);
        const st: ClientState = {
          buf: new Uint8Array(0),
          tunnel: null,
          forwardUpstream: null,
          forwardedDone: false,
          connecting: false,
          connId: crypto.randomUUID(),
        };
        (socket.data as unknown as ClientState) = st;
      },
      data(socket, chunk) {
        const st = socket.data as unknown as ClientState;
        if (st.tunnel) {
          // 隧道态：客户端 → 上游
          st.tunnel.upstream.write(chunk as Buffer).catch(() => socket.end());
          return;
        }
        if (st.connecting) {
          // CONNECT 已接受、上游建立前的早期数据：缓冲
          const merged = new Uint8Array(st.buf.length + chunk.byteLength);
          merged.set(st.buf);
          merged.set(chunk as Buffer, st.buf.length);
          st.buf = merged;
          if (st.buf.length > MAX_HEADER) socket.end();
          return;
        }
        const merged = new Uint8Array(st.buf.length + chunk.byteLength);
        merged.set(st.buf);
        merged.set(chunk as Buffer, st.buf.length);
        st.buf = merged;
        if (st.buf.length > MAX_HEADER) {
          socket.end('HTTP/1.1 431 Too Large\r\n\r\n');
          return;
        }
        const headerEnd = findHeaderEnd(st.buf);
        if (headerEnd < 0) return;
        const headerText = new TextDecoder().decode(st.buf.subarray(0, headerEnd));
        const rest = st.buf.subarray(headerEnd);
        st.buf = new Uint8Array(0);
        handle(socket, st, headerText, rest).catch((e: unknown) => {
          log.warn(`http inbound handler error: ${String(e).slice(0, 100)}`);
          socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
      },
      close(socket) {
        const st = socket.data as unknown as ClientState;
        st.tunnel?.upstream.close();
        st.forwardUpstream = null;
        st.forwardedDone = true;
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

    function findHeaderEnd(buf: Uint8Array): number {
      for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4;
      }
      return -1;
    }

    async function handle(
      socket: Bun.Socket<undefined>,
      st: ClientState,
      headerText: string,
      rest: Uint8Array,
    ): Promise<void> {
      const lines = headerText.split('\r\n');
      const first = lines[0] ?? '';
      const m = /^(\w+) (\S+) HTTP\/[\d.]+$/.exec(first);
      if (!m) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const method = m[1] as string;
      const target = m[2] as string;

      if (method === 'CONNECT') {
        const tm = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
        if (!tm) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        const host = (tm[1] as string).replace(/^\[|\]$/g, '').toLowerCase();
        const port = Number(tm[2]);
        st.connecting = true;
        await tunnel(socket, st, host, port, rest);
        return;
      }

      // 非 CONNECT：需要绝对形式或 Host 头
      let host: string;
      let port: number;
      let rewritten = headerText;
      if (/^https?:\/\//.test(target)) {
        let url: URL;
        try {
          url = new URL(target);
        } catch (_e) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        host = url.hostname.toLowerCase();
        port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
        const origin = `${method} ${url.pathname}${url.search} HTTP/1.1`;
        rewritten = [origin, ...lines.slice(1)].join('\r\n');
      } else {
        const hostHeader = lines.find((l) => l.toLowerCase().startsWith('host:'));
        if (!hostHeader) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        const hp = splitHostPort(hostHeader.slice(5).trim());
        host = hp[0];
        port = hp[1] ?? 80;
      }

      const picked = pick(host, port);
      if ('error' in picked) {
        socket.end(`HTTP/1.1 ${picked.error} ${picked.error === 403 ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`);
        return;
      }
      let upstream: Conn;
      try {
        upstream = await picked.outbound.connect({ type: 'fqdn', host, port });
      } catch (_e) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      const addr: SocksAddr = { type: 'fqdn', host, port };
      void addr;
      clearHandshakeTimer(socket);
      const metered = new MeteredPipe(upstream);
      st.forwardUpstream = metered;
      onOpen?.({
        id: st.connId,
        host,
        port,
        chain: [picked.outbound.name],
        meter: metered,
        close: () => socket.end(),
      });
      const payloadBytes = new TextEncoder().encode(rewritten);
      const body = new Uint8Array(payloadBytes.length + rest.length);
      body.set(payloadBytes);
      body.set(rest, payloadBytes.length);
      try {
        await metered.write(body);
        await pumpForwardedResponse(socket, metered);
      } catch (_e) {
        socket.end();
      } finally {
        upstream.close();
        st.forwardUpstream = null;
        if (st.forwardedDone !== true) {
          st.forwardedDone = true;
          onClose?.(st.connId);
        }
      }
    }

    /** 单请求转发：Content-Length 已知则精确读完即收（上游 keep-alive 不必等）；未知则读到 EOF/空闲超时 */
    async function pumpForwardedResponse(socket: Bun.Socket<undefined>, metered: MeteredPipe): Promise<void> {
      let remaining: number | null = null;
      let headerBuf = new Uint8Array(0);
      let headerDone = false;
      for (;;) {
        const chunk = await withIdleTimeout(metered.read(65536), 30000);
        socket.write(chunk);
        if (!headerDone) {
          const merged = new Uint8Array(headerBuf.length + chunk.length);
          merged.set(headerBuf);
          merged.set(chunk, headerBuf.length);
          headerBuf = merged;
          const idx = indexOfCrlfCrlf(headerBuf);
          if (idx >= 0) {
            headerDone = true;
            const head = new TextDecoder().decode(headerBuf.subarray(0, idx));
            const cl = /content-length:\s*(\d+)/i.exec(head);
            if (cl) {
              const total = Number(cl[1]);
              const bodySeen = headerBuf.length - (idx + 4);
              remaining = Math.max(total - bodySeen, 0);
              if (remaining === 0) return;
            }
          } else if (headerBuf.length > MAX_HEADER) {
            return; // 异常超大响应头：放弃解析，靠 EOF/超时收尾
          }
        } else if (remaining !== null) {
          remaining -= chunk.length;
          if (remaining <= 0) return;
        }
      }
    }

    function indexOfCrlfCrlf(buf: Uint8Array): number {
      for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4;
      }
      return -1;
    }

    async function tunnel(
      socket: Bun.Socket<undefined>,
      st: ClientState,
      host: string,
      port: number,
      initial: Uint8Array,
    ): Promise<void> {
      const picked = pick(host, port);
      if ('error' in picked) {
        st.connecting = false;
        const reason = picked.error === 403 ? 'Forbidden' : 'Bad Gateway';
        const body = picked.error === 403 ? 'blocked by rule' : 'upstream fail';
        socket.end(`HTTP/1.1 ${picked.error} ${reason}\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
        return;
      }
      let upstream: Conn;
      try {
        upstream = await picked.outbound.connect({ type: 'fqdn', host, port });
      } catch (_e) {
        st.connecting = false;
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 13\r\n\r\nupstream fail');
        return;
      }
      const chain = [picked.outbound.name];
      const id = st.connId;
      let tunnelMeter: MeteredPipe | null = null;
      const holder = {
        uploaded: () => tunnelMeter?.uploaded() ?? 0,
        downloaded: () => tunnelMeter?.downloaded() ?? 0,
        upRate: () => tunnelMeter?.upRate() ?? 0,
        downRate: () => tunnelMeter?.downRate() ?? 0,
      };
      onOpen?.({ id, host, port, chain, meter: holder, close: () => socket.end() });
      clearHandshakeTimer(socket);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      st.connecting = false;
      const early = st.buf;
      st.buf = new Uint8Array(0);
      const initialAll = new Uint8Array(early.length + initial.length);
      initialAll.set(early);
      initialAll.set(initial, early.length);
      const metered = new MeteredPipe(upstream);
      tunnelMeter = metered;
      st.tunnel = {
        upstream: Object.assign(metered, {
          closed: upstream.closed,
          close: () => upstream.close(),
        }) as Conn & MeteredPipe,
      };
      initial = initialAll;
      if (initial.length > 0) {
        try {
          await upstream.write(initial);
        } catch (_e) {
          socket.end();
          return;
        }
      }
      // 上游 → 客户端（经 meter 计量）
      void (async () => {
        try {
          for (;;) {
            const chunk = await st.tunnel!.upstream.read(65536);
            socket.write(chunk);
          }
        } catch (_e) {
          socket.end();
        }
      })();
    }
  }
}

function splitHostPort(s: string): [string, number | undefined] {
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close > 0) {
      const host = s.slice(1, close);
      const rest = s.slice(close + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : undefined;
      return [host, Number.isInteger(port) ? port : undefined];
    }
  }
  const idx = s.lastIndexOf(':');
  if (idx < 0) return [s.toLowerCase(), undefined];
  const host = s.slice(0, idx).toLowerCase();
  const port = Number(s.slice(idx + 1));
  if (Number.isInteger(port) && port > 0) return [host, port];
  return [s.toLowerCase(), undefined];
}
