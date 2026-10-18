/**
 * 本地 AnyTLS 测试服务端（design.md §1.7）：TLS(RSA 自签) + 认证 + 会话层 + 逐流回显。
 * v2 特性（SYNACK/HeartRequest 响应/ServerSettings/UpdatePaddingScheme 下发）与 v1 模式
 * 均支持，供会话层行为测试与 e2e 使用。
 */

import { logger } from '../../../core/log.ts';
import { decodeSocksAddr, type SocksAddr } from '../../../core/socksaddr.ts';
import { CMD, decodeFrame, decodeStringMap, encodeFrame, encodeStringMap } from '../frame.ts';
import { DEFAULT_PADDING_SCHEME, makePaddingFactory, md5Hex } from '../padding.ts';
import { generateSelfSignedCert } from './mkcert.ts';

const log = logger('anytls:test-server');

export interface TestServerOptions {
  port?: number;
  password: string;
  /** v2 特性开关（默认 true；false = 模拟 v1 老服务端） */
  v2?: boolean;
  /** 收到首个 settings 后下发的新 padding scheme（null = 不下发） */
  pushPaddingScheme?: string | null;
}

interface ConnState {
  authed: boolean;
  recvBuf: Uint8Array;
  streams: Map<number, { addr: SocksAddr | null; pending: Uint8Array | null }>;
  gotSettings: boolean;
  peerVersion: number;
}

/** 会话级事件回放给测试断言 */
export interface ServerEvents {
  targets: string[];
  alerts: string[];
  authFailures: number;
  schemesPushed: number;
  heartRequestsSent: number;
}

export class AnytlsTestServer {
  private listener: Bun.TCPSocketListener<undefined> | null = null;
  port = 0;
  readonly events: ServerEvents = { targets: [], alerts: [], authFailures: 0, schemesPushed: 0, heartRequestsSent: 0 };
  private opts: TestServerOptions;

  constructor(opts: TestServerOptions) {
    this.opts = { v2: true, ...opts };
  }

  async start(): Promise<void> {
    const { certPem, keyPem } = await generateSelfSignedCert();
    const defaultFactory = makePaddingFactory(DEFAULT_PADDING_SCHEME);
    if (!defaultFactory) throw new Error('bad default padding');
    const defaultMd5 = defaultFactory.md5;
    const expectSha = new Uint8Array(new Bun.CryptoHasher('sha256').update(this.opts.password).digest());
    const opts = this.opts;
    const events = this.events;

    this.listener = Bun.listen({
      hostname: '127.0.0.1',
      port: opts.port ?? 0,
      tls: { cert: certPem, key: keyPem },
      socket: {
        open(socket) {
          const st: ConnState = {
            authed: false,
            recvBuf: new Uint8Array(0),
            streams: new Map(),
            gotSettings: false,
            peerVersion: 1,
          };
          (socket.data as unknown as ConnState) = st;
        },
        data(socket, chunk) {
          const st = socket.data as unknown as ConnState;
          log.debug(`chunk ${chunk.byteLength}B authed=${st.authed}`);
          const merged = new Uint8Array(st.recvBuf.length + chunk.byteLength);
          merged.set(st.recvBuf);
          merged.set(chunk as Buffer, st.recvBuf.length);
          st.recvBuf = merged;
          handleBuf(socket, st);
        },
        close() {},
        error(_s, err) {
          log.debug(`conn error: ${String(err)}`);
        },
      },
    });
    this.port = this.listener.port;

    function send(socket: Bun.Socket<undefined>, cmd: number, sid: number, data: Uint8Array = new Uint8Array(0)): void {
      socket.write(encodeFrame(cmd, sid, data));
    }

    function handleBuf(socket: Bun.Socket<undefined>, st: ConnState): void {
      if (!st.authed) {
        // 认证：sha256(32) + u16 padlen + pad
        if (st.recvBuf.length < 34) return;
        const padLen = new DataView(st.recvBuf.buffer, st.recvBuf.byteOffset).getUint16(32, false);
        if (st.recvBuf.length < 34 + padLen) return;
        const sha = st.recvBuf.subarray(0, 32);
        const ok = sha.every((b, i) => b === expectSha[i]);
        st.recvBuf = st.recvBuf.subarray(34 + padLen);
        if (!ok) {
          events.authFailures++;
          send(socket, CMD.alert, 0, new TextEncoder().encode('auth failed'));
          socket.end();
          return;
        }
        st.authed = true;
        if (st.recvBuf.length > 0) handleFrames(socket, st);
        return;
      }
      handleFrames(socket, st);
    }

    function handleFrames(socket: Bun.Socket<undefined>, st: ConnState): void {
      for (;;) {
        const r = decodeFrame(st.recvBuf);
        log.debug(`frame cmd=${r.ok ? r.frame.cmd : '?'} buflen=${st.recvBuf.length} ok=${r.ok}`);
        if (!r.ok) return;
        const frame = r.frame;
        st.recvBuf = st.recvBuf.subarray(r.consumed);
        switch (frame.cmd) {
          case CMD.settings: {
            if (st.gotSettings) break; // 重复 settings 忽略
            st.gotSettings = true;
            const m = decodeStringMap(frame.data);
            const v = Number(m['v']);
            st.peerVersion = Number.isInteger(v) ? v : 1;
            const clientMd5 = m['padding-md5'];
            if (clientMd5 !== undefined && clientMd5 !== defaultMd5 && opts.pushPaddingScheme !== null) {
              const scheme = opts.pushPaddingScheme ?? DEFAULT_PADDING_SCHEME;
              send(socket, CMD.updatePaddingScheme, 0, new TextEncoder().encode(scheme));
              events.schemesPushed++;
            }
            if (opts.v2 !== false && st.peerVersion >= 2) {
              send(socket, CMD.serverSettings, 0, encodeStringMap({ v: '2' }));
            }
            break;
          }
          case CMD.syn: {
            log.debug(`syn sid=${frame.sid} gotSettings=${st.gotSettings}`);
            if (!st.gotSettings) {
              send(socket, CMD.alert, 0, new TextEncoder().encode('client did not send its settings'));
              socket.end();
              return;
            }
            st.streams.set(frame.sid, { addr: null, pending: null });
            // SYNACK（握手成功形态；回显服务器无需真实拨号）
            if (opts.v2 !== false && st.peerVersion >= 2) {
              send(socket, CMD.synack, frame.sid);
            }
            break;
          }
          case CMD.psh: {
            const stream = st.streams.get(frame.sid);
            log.debug(`psh sid=${frame.sid} ${frame.data.length}B stream=${!!stream}`);
            if (!stream) break;
            if (stream.addr === null) {
              const buf = stream.pending
                ? new Uint8Array([...stream.pending, ...frame.data])
                : frame.data;
              try {
                const { addr, consumed } = decodeSocksAddr(buf);
                stream.addr = addr;
                events.targets.push(`${addr.host}:${addr.port}`);
                const rest = buf.subarray(consumed);
                if (rest.length > 0) socket.write(encodeFrame(CMD.psh, frame.sid, rest)); // 回显剩余
              } catch (_e) {
                stream.pending = buf;
              }
            } else {
              socket.write(encodeFrame(CMD.psh, frame.sid, frame.data)); // 回显
            }
            break;
          }
          case CMD.fin: {
            st.streams.delete(frame.sid);
            break;
          }
          case CMD.heartRequest: {
            send(socket, CMD.heartResponse, frame.sid);
            break;
          }
          case CMD.waste:
            break;
          case CMD.alert:
            events.alerts.push(new TextDecoder().decode(frame.data));
            socket.end();
            break;
          default:
            break;
        }
      }
    }
  }

  /** 主动向某条连接发心跳请求（测试客户端响应）；简化：仅记录调用 */
  heartRequestSent(): void {
    this.events.heartRequestsSent++;
  }

  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
  }
}

void md5Hex;
