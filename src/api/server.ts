/**
 * REST API（Clash 兼容子集；design.md §1.6/D3）：仅 127.0.0.1。
 * GET /version /proxies /proxies/:name /rules /connections；PUT /proxies/:name；DELETE /connections/:id。
 */

import { logger } from '../core/log.ts';
import { PROGRAM_VERSION } from '../core/version.ts';
import type { ConnectionTracker } from '../core/connections.ts';
import type { Outbound } from '../core/types.ts';
import type { RuleEngine } from '../rules/index.ts';
import { SelectGroup } from '../rules/groups.ts';
import type { HealthSummary } from '../core/health.ts';

const log = logger('api');

const MAX_BODY = 64 * 1024;

export interface ApiDeps {
  tracker: ConnectionTracker;
  /** 本机回环端口（Host 头校验用） */
  loopbackPort: number;
  outboundOf(name: string): Outbound | undefined;
  outboundNames(): string[];
  engine: RuleEngine;
  secret: string;
  setMode(mode: 'rule' | 'global' | 'direct'): boolean;
  currentMode(): 'rule' | 'global' | 'direct';
}

export class RestApi {
  private server: Bun.TCPSocketListener<undefined> | null = null;
  port = 0;
  private deps: ApiDeps;

  constructor(deps: ApiDeps) {
    this.deps = deps;
  }

  async start(configuredAddr: string | null): Promise<void> {
    let port = 9090;
    if (configuredAddr) {
      const m = /:(\d+)$/.exec(configuredAddr);
      if (m) port = Number(m[1]);
      if (!/^127\.0\.0\.1|^localhost/.test(configuredAddr)) {
        log.warn('external-controller forced to 127.0.0.1 (D3: API must not expose beyond loopback)');
      }
    }
    try {
      this.server = Bun.listen({
        hostname: '127.0.0.1',
        port,
        socket: this.handler(),
      });
      this.port = this.server.port;
      this.deps.loopbackPort = this.port;
      log.info(`api on 127.0.0.1:${this.port}`);
    } catch (e) {
      log.error(`api bind failed on 127.0.0.1:${port}: ${String(e).slice(0, 80)}`);
      throw e;
    }
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private handler(): Bun.SocketHandler<undefined> {
    const deps = this.deps;
    return {
      open(socket) {
        (socket.data as unknown as { buf: Uint8Array; bodyLen: number; headerEnd: number }) = {
          buf: new Uint8Array(0),
          bodyLen: -1,
          headerEnd: -1,
        };
      },
      data(socket, chunk) {
        const st = socket.data as unknown as { buf: Uint8Array; bodyLen: number; headerEnd: number };
        const merged = new Uint8Array(st.buf.length + chunk.byteLength);
        merged.set(st.buf);
        merged.set(chunk as Buffer, st.buf.length);
        st.buf = merged;
        if (st.headerEnd < 0) {
          const end = findHeaderEnd(st.buf);
          if (end < 0) {
            if (st.buf.length > 16 * 1024) socket.end();
            return;
          }
          st.headerEnd = end;
          const headerText = new TextDecoder().decode(st.buf.subarray(0, end));
          const cl = /content-length:\s*(\d+)/i.exec(headerText);
          st.bodyLen = cl ? Number(cl[1]) : 0;
          if (st.bodyLen > MAX_BODY) {
            socket.end('HTTP/1.1 413 Payload Too Large\r\n\r\n');
            return;
          }
        }
        const total = st.headerEnd + st.bodyLen;
        if (st.buf.length < total) return; // 等 body 到齐
        const text = new TextDecoder().decode(st.buf.subarray(0, st.headerEnd));
        const body = new TextDecoder().decode(st.buf.subarray(st.headerEnd, total));
        st.buf = new Uint8Array(0);
        st.headerEnd = -1;
        st.bodyLen = -1;
        handle(socket, text, body).catch((e: unknown) => {
          log.error(`api handler error: ${String(e).slice(0, 120)}`);
          try {
            socket.end('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n');
          } catch (_e2) {
            /* socket gone */
          }
        });
      },
      close() {},
      error() {},
    };

    function findHeaderEnd(buf: Uint8Array): number {
      for (let i = 0; i + 3 < buf.length; i++) {
        if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4;
      }
      return -1;
    }

    function json(socket: Bun.Socket<undefined>, status: number, body: unknown): void {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const reasons: Record<number, string> = {
        200: 'OK', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found',
      };
      const reason = reasons[status] ?? 'Error';
      const bytes = new TextEncoder().encode(payload);
      const head =
        `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${bytes.length}\r\n\r\n`;
      const out = new Uint8Array(head.length + bytes.length);
      out.set(new TextEncoder().encode(head));
      out.set(bytes, head.length);
      socket.end(out);
    }

    async function handle(socket: Bun.Socket<undefined>, head: string, body: string): Promise<void> {
      const [requestLine, ...headerLines] = head.split('\r\n');
      const rl = requestLine ?? '';
      const m = /^(\w+) (\S+) HTTP\/[\d.]+$/.exec(rl);
      if (!m) {
        json(socket, 400, { message: 'bad request' });
        return;
      }
      const method = m[1] as string;
      const rawPath = (m[2] as string).split('?')[0] as string;
      let path = rawPath;
      if (rawPath.includes('%')) {
        try {
          path = decodeURIComponent(rawPath);
        } catch (_e) {
          json(socket, 400, { message: 'malformed percent-encoding' });
          return;
        }
      }
      // DNS rebinding / 浏览器直连防护：Host 必须是本机回环
      const hostLine = headerLines.find((h) => h.toLowerCase().startsWith('host:'));
      const hostValue = hostLine?.slice(5).trim().toLowerCase() ?? '';
      const loopbackHost = new Set([
        `127.0.0.1:${deps.loopbackPort}`,
        `localhost:${deps.loopbackPort}`,
        '127.0.0.1',
        'localhost',
        '[::1]',
      ]);
      if (!loopbackHost.has(hostValue)) {
        json(socket, 403, { message: 'non-local host rejected' });
        return;
      }

      if (deps.secret) {
        const authLine = headerLines.find((h) => h.toLowerCase().startsWith('authorization:'));
        const raw = authLine?.slice(authLine.indexOf(':') + 1).trim() ?? '';
        const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
        if (token !== deps.secret) {
          json(socket, 401, { message: 'Unauthorized' });
          return;
        }
      }

      if (method === 'GET' && path === '/version') {
        json(socket, 200, { version: PROGRAM_VERSION });
        return;
      }
      if (method === 'GET' && path === '/proxies') {
        const proxies: Record<string, unknown> = {};
        for (const name of deps.outboundNames()) {
          proxies[name] = proxyView(deps.outboundOf(name));
        }
        json(socket, 200, { proxies });
        return;
      }
      const pm = /^\/proxies\/(.+)$/.exec(path);
      if (pm) {
        const name = pm[1] as string;
        const outbound = deps.outboundOf(name);
        if (!outbound) {
          json(socket, 404, { message: 'proxy not found' });
          return;
        }
        if (method === 'GET') {
          json(socket, 200, proxyView(outbound));
          return;
        }
        if (method === 'PUT') {
          const group = outbound as SelectGroup;
          if (typeof group.select !== 'function') {
            json(socket, 400, { message: 'proxy is not a selector' });
            return;
          }
          let target = '';
          try {
            const parsed = JSON.parse(body) as { now?: unknown };
            if (typeof parsed.now === 'string') target = parsed.now;
          } catch (_e) {
            // body 非 JSON
          }
          if (!target) {
            json(socket, 400, { message: 'body must be {"now": "<member>"}' });
            return;
          }
          const ok = group.select(target);
          if (!ok) {
            json(socket, 400, { message: `member '${target}' not found` });
            return;
          }
          json(socket, 204, '');
          return;
        }
      }
      if (method === 'GET' && path === '/configs') {
        json(socket, 200, { mode: deps.currentMode() });
        return;
      }
      if (method === 'PATCH' && path === '/configs') {
        let mode = '';
        try {
          const parsed = JSON.parse(body) as { mode?: unknown };
          if (typeof parsed.mode === 'string') mode = parsed.mode;
        } catch (_e) {
          // body 非 JSON
        }
        if (mode !== 'rule' && mode !== 'global' && mode !== 'direct') {
          json(socket, 400, { message: 'mode must be rule|global|direct' });
          return;
        }
        const ok = deps.setMode(mode);
        json(socket, ok ? 204 : 400, ok ? '' : { message: 'switch failed' });
        return;
      }
      if (method === 'GET' && path === '/rules') {
        json(socket, 200, { rules: deps.engine.listRules() });
        return;
      }
      if (method === 'GET' && path === '/connections') {
        const totals = deps.tracker.sessionTotals();
        json(socket, 200, {
          totals: { upload: totals.upload, download: totals.download },
          connections: deps.tracker.snapshot().map((c) => ({
            id: c.id,
            metadata: {
              host: c.host,
              destinationIP: c.destinationIP,
              destinationPort: c.port,
            },
            upload: c.meter.uploaded(),
            download: c.meter.downloaded(),
            upRate: c.meter.upRate(),
            downRate: c.meter.downRate(),
            start: c.start,
            chains: c.chains,
          })),
        });
        return;
      }
      const cm = /^\/connections\/(.+)$/.exec(path);
      if (cm && method === 'DELETE') {
        const ok = deps.tracker.close(cm[1] as string);
        json(socket, ok ? 204 : 404, ok ? '' : { message: 'connection not found' });
        return;
      }
      json(socket, 404, { message: 'no such endpoint' });
    }

    function proxyView(outbound: Outbound | undefined): Record<string, unknown> {
      if (!outbound) return {};
      const group = outbound as SelectGroup;
      const isSelector = typeof group.select === 'function';
      const auto = outbound as unknown as {
        memberNames?(): string[];
        current?(): string;
        delays?(): Record<string, number | null>;
      };
      return {
        name: outbound.name,
        type: isSelector ? 'Selector' : ((outbound as unknown as { typeName?: string }).typeName ?? 'Static'),
        now: typeof group.current === 'function' ? group.current() : undefined,
        all: typeof auto.memberNames === 'function' ? auto.memberNames() : undefined,
        history: typeof auto.delays === 'function' ? auto.delays() : {} as Record<string, number | null>,
        health: healthView(outbound),
        udp: false,
      };
    }

    function healthView(outbound: Outbound): Record<string, unknown> | null {
      const cap = outbound as unknown as { health?(): HealthSummary };
      if (typeof cap.health !== 'function') return null;
      const h = cap.health();
      return {
        alive: h.alive,
        delay: h.delayMs,
        avgDelay: h.avgDelayMs,
        successRate: h.successRate,
        samples: h.samples,
      };
    }
  }
}
