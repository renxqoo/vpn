/**
 * AnyTLS 会话层（design.md §1.4；对齐 anytls-go session.go）。
 * TCP Proxy -> Stream -> Session -> TLS -> TCP。
 *
 * Bun socket 事件驱动：读循环由 socket.data 回调驱动，写路径串行化（对齐 Go connLock）。
 * Stream 提供类 net.Conn 的 reader/writer 接口（Promise 化）。
 */

import { logger } from '../../core/log.ts';
import type { RandomSource } from '../../core/random.ts';
import { cryptoRandom } from '../../core/random.ts';
import { encodeSocksAddr, type SocksAddr } from '../../core/socksaddr.ts';
import { CMD, decodeFrame, decodeStringMap, encodeFrame, encodeStringMap, HEADER_SIZE } from './frame.ts';
import {
  type PaddingFactory,
  generateRecordPayloadSizes,
  makeWasteFrame,
  planChunks,
} from './padding.ts';

const log = logger('anytls:session');

export interface SessionHooks {
  /** 会话死亡时回调（池需要把自己摘掉） */
  onDead(): void;
  /** 收到服务器 UpdatePaddingScheme（Client 级更新，返回是否接受） */
  onUpdatePaddingScheme(raw: string): boolean;
  /** 收到 Alert */
  onAlert(msg: string): void;
}

export interface SessionOptions {
  hooks: SessionHooks;
  padding: () => PaddingFactory;
  random?: RandomSource;
  /** v2 SYNACK 等待超时（默认 3s；0 = 禁用） */
  synTimeoutMs?: number;
  clientName: string;
}

/** 写请求队列项 */
interface WriteJob {
  bytes: Uint8Array[];
  resolve(): void;
  reject(e: Error): void;
}

const MAX_STREAM_BUFFER = 256 * 1024; // 单流读缓冲上界（design §2.5）

export class AnytlsSession {
  readonly seq: number;
  private socket: Bun.Socket<undefined> | null;
  private opts: SessionOptions;
  private rnd: RandomSource;
  private streams = new Map<number, AnytlsStream>();
  private nextSid = 0;
  /** 本会话累计打开的流数（池的超载判定单一真相） */
  openedStreams = 0;
  private dead = false;
  private connected = false;
  private dieReason = '';
  private writeQueue: WriteJob[] = [];
  private writeQueueBytes = 0;
  private static readonly MAX_WRITE_QUEUE_BYTES = 4 * 1024 * 1024;
  private writing = false;
  private recvBuf = new Uint8Array(0);
  // 认证后立即 settings + buffering，对齐参考实现：直到首个 SYN 发出才 flush
  private buffering = true;
  private bufferList: Uint8Array[] = [];
  private sendPadding = true;
  private pktCounter = 0;
  private peerVersion = 1;
  private onServerSettings: ((v: number) => void) | null = null;
  idleSince = 0; // 池管理用

  constructor(socket: Bun.Socket<undefined>, seq: number, password: string, opts: SessionOptions) {
    this.socket = socket;
    this.seq = seq;
    this.opts = opts;
    this.rnd = opts.random ?? cryptoRandom;
    // handler 由 client 在 connect 时绑定（feedData/die 公开）；这里不做 socket.reload
    // 认证 + settings（buffering 状态下先入缓冲，首个 OpenStream flush）
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(password);
    const sha = hasher.digest();
    const pad0 = generateRecordPayloadSizes(opts.padding(), 0, this.rnd)[0] ?? 30;
    const auth = new Uint8Array(32 + 2 + pad0);
    auth.set(new Uint8Array(sha), 0);
    new DataView(auth.buffer).setUint16(32, pad0, false);
    this.bufferList.push(auth);
    const settings = encodeStringMap({
      v: '2',
      client: opts.clientName,
      'padding-md5': opts.padding().md5,
    });
    this.bufferList.push(encodeFrame(CMD.settings, 0, settings));
  }

  /** socket 数据入口（client 的 connect handler 绑定） */
  feedData(data: Buffer): void {
    this.onData(data);
  }

  /** 连接就绪（open 回调后调用）：放行写队列 */
  markConnected(): void {
    this.connected = true;
    void this.drain();
  }

  isDead(): boolean {
    return this.dead;
  }

  die(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.dieReason = reason;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const st of streams) st.remoteClosed(reason);
    for (const job of this.writeQueue.splice(0)) job.reject(new Error(`session dead: ${reason}`));
    this.writeQueueBytes = 0;
    try {
      this.socket?.end();
    } catch (_e) {
      /* already closed */
    }
    this.opts.hooks.onDead();
    const level = reason === 'local close' ? 'debug' : 'warn';
    log[level](`session ${this.seq} dead: ${reason}`);
  }

  get dieInfo(): string {
    return this.dieReason;
  }

  /** 打开新流；首个 SYN 触发 auth+settings 缓冲一并按序发送（对齐参考实现 pkt1 语义） */
  openStream(): AnytlsStream {
    if (this.dead) throw new Error(`session ${this.seq} is dead (${this.dieReason})`);
    const sid = ++this.nextSid;
    const stream = new AnytlsStream(sid, this);
    this.streams.set(sid, stream);
    this.openedStreams++;
    const syn = encodeFrame(CMD.syn, sid);
    if (this.buffering) {
      // auth 直发（不进 writeConn，对齐参考 createOutboundConnection）；
      // settings + SYN 合并为一次 padding 写（= 参考 pkt1：cmdSettings 与首个 cmdSYN 同 Write TLS）
      this.buffering = false;
      const buffered = this.bufferList;
      this.bufferList = [];
      const [authBytes, ...restFrames] = buffered;
      this.enqueue([authBytes ?? new Uint8Array(0)], false);
      this.enqueue([...restFrames, syn], true);
    } else {
      this.writeFrames(syn);
    }
    return stream;
  }

  /** SYNACK 到达（v2） */
  private onSynack(sid: number, data: Uint8Array): void {
    const stream = this.streams.get(sid);
    if (!stream) return;
    if (data.length > 0) {
      stream.remoteClosed(`remote: ${new TextDecoder().decode(data)}`);
      this.streams.delete(sid);
    } else {
      stream.onSynack();
    }
  }

  streamClosed(sid: number): void {
    this.streams.delete(sid);
    if (!this.dead) this.writeFrames(encodeFrame(CMD.fin, sid));
  }

  private onData(data: Buffer): void {
    log.debug(`session ${this.seq} recv ${data.length}B`);
    const merged = new Uint8Array(this.recvBuf.length + data.length);
    merged.set(this.recvBuf);
    merged.set(data, this.recvBuf.length);
    let offset = 0;
    for (;;) {
      const r = decodeFrame(merged, offset);
      if (!r.ok) break;
      this.handleFrame(r.frame);
      offset += r.consumed;
    }
    this.recvBuf = merged.subarray(offset);
  }

  private handleFrame(frame: { cmd: number; sid: number; data: Uint8Array }): void {
    log.debug(`session ${this.seq} frame cmd=${frame.cmd} sid=${frame.sid} ${frame.data.length}B`);
    switch (frame.cmd) {
      case CMD.psh: {
        if (frame.data.length === 0) break;
        const stream = this.streams.get(frame.sid);
        if (stream) stream.onData(frame.data);
        break;
      }
      case CMD.synack:
        this.onSynack(frame.sid, frame.data);
        break;
      case CMD.fin: {
        const stream = this.streams.get(frame.sid);
        this.streams.delete(frame.sid);
        if (stream) stream.remoteClosed('remote fin');
        break;
      }
      case CMD.waste:
        break; // 丢弃
      case CMD.settings:
        break; // 客户端不关心对端 settings
      case CMD.alert: {
        const msg = new TextDecoder().decode(frame.data);
        this.opts.hooks.onAlert(msg);
        this.die(`server alert: ${msg}`);
        break;
      }
      case CMD.updatePaddingScheme: {
        const raw = new TextDecoder().decode(frame.data);
        const ok = this.opts.hooks.onUpdatePaddingScheme(raw);
        log.info(`update padding scheme: ${ok ? 'accepted' : 'rejected'}`);
        break;
      }
      case CMD.heartRequest:
        this.writeFrames(encodeFrame(CMD.heartResponse, frame.sid));
        break;
      case CMD.heartResponse:
        break;
      case CMD.serverSettings: {
        const m = decodeStringMap(frame.data);
        const v = Number(m['v']);
        if (Number.isInteger(v) && v >= 1) {
          this.peerVersion = v;
          if (this.onServerSettings) this.onServerSettings(v);
        }
        break;
      }
      default:
        // 未知 cmd：读出即丢（协议允许不携带 data 的未知命令）
        break;
    }
  }

  /** 等待 ServerSettings（v2 协商）；返回服务器版本号 */
  waitServerSettings(timeoutMs: number): Promise<number> {
    if (this.peerVersion > 1) return Promise.resolve(this.peerVersion);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          this.onServerSettings = null;
          resolve(1); // v1 服务器不下发——默认 1
        }
      }, timeoutMs);
      this.onServerSettings = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.onServerSettings = null;
        resolve(v);
      };
    });
  }

  /** 流数据写入：拆 ≤65535 的帧，走 padding 写路径；返回用户字节数 */
  async writeStreamData(sid: number, data: Uint8Array): Promise<number> {
    if (this.dead) throw new Error(`session dead: ${this.dieReason}`);
    if (data.length === 0) return 0;
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < data.length; off += 0xffff) {
      chunks.push(encodeFrame(CMD.psh, sid, data.subarray(off, off + 0xffff)));
    }
    await this.enqueue(chunks, true);
    return data.length;
  }

  /** 控制帧入队（同样走 padding 写路径——参考实现 writeControlFrame 也经 writeConn） */
  private writeFrames(...frames: Uint8Array[]): void {
    this.enqueue(frames, true).catch((e: unknown) => {
      // 会话死亡/写队列溢出时控制帧（SYN/FIN/心跳应答）无法送达：会话已被 die() 终结，
      // 这里只留痕防止未处理 rejection 击杀进程
      log.debug(`control frame dropped on dying session ${this.seq}: ${String(e).slice(0, 60)}`);
    });
  }

  /** 入队；applyPadding=true 时数据帧走 padding 分包。队列字节超界 = 上游拥塞失控，断会话（与接收方向对称） */
  private async enqueue(chunks: Uint8Array[], applyPadding = false): Promise<void> {
    const queuedBytes = chunks.reduce((n, b) => n + b.length, 0);
    if (this.writeQueueBytes + queuedBytes > AnytlsSession.MAX_WRITE_QUEUE_BYTES) {
      this.die('write queue overflow (upstream stalled)');
      return Promise.reject(new Error('write queue overflow'));
    }
    this.writeQueueBytes += queuedBytes;
    const job: WriteJob & PaddingJob = { bytes: applyPadding ? [] : chunks, resolve() {}, reject() {} };
    if (applyPadding) {
      job.padding = true;
      job.src = chunks;
    }
    const p = new Promise<void>((r, rej) => {
      job.resolve = r;
      job.reject = rej;
    });
    this.writeQueue.push(job);
    void this.drain();
    return p;
  }

  /** 原始字节（auth+settings flush）入队，同样走 padding（认证 padding0 之外的会话部分） */
  private writeRaw(chunks: Uint8Array[]): Promise<void> {
    return this.enqueue(chunks, true);
  }

  private async drain(): Promise<void> {
    if (this.writing || !this.connected) return;
    this.writing = true;
    try {
      while (this.writeQueue.length > 0 && !this.dead) {
        const job = this.writeQueue.shift() as WriteJob & PaddingJob;
        this.writeQueueBytes -= job.bytes.reduce((n, b) => n + b.length, 0);
        if (job.src) this.writeQueueBytes -= job.src.reduce((n, b) => n + b.length, 0);
        let failed = false;
        try {
          if (job.padding === true && job.src) {
            await this.writeWithPadding(job.src);
          } else {
            await this.writeSocket(job.bytes.flat());
          }
        } catch (e) {
          failed = true;
          job.reject(e instanceof Error ? e : new Error(String(e)));
        } finally {
          if (!failed) job.resolve();
        }
      }
    } finally {
      this.writing = false;
    }
  }

  private writeSocket(bytes: Uint8Array[]): Promise<void> {
    const sock = this.socket;
    if (!sock || this.dead) {
      const total = bytes.reduce((n, b) => n + b.length, 0);
      if (total === 0) return Promise.resolve();
      return Promise.reject(new Error(`session dead: ${this.dieReason}`));
    }
    const total = bytes.reduce((n, b) => n + b.length, 0);
    if (total === 0) return Promise.resolve();
    const merged = new Uint8Array(total);
    let off = 0;
    for (const b of bytes) {
      merged.set(b, off);
      off += b.length;
    }
    try {
      const n = sock.write(merged);
      if (n < 0) throw new Error('socket write failed');
      return Promise.resolve();
    } catch (e) {
      this.die(`write error: ${String(e)}`);
      return Promise.reject(new Error(String(e)));
    }
  }

  /** padding 写路径（对齐 writeConn：pkt 计数、分包、waste 补齐；控制帧不走这里） */
  private async writeWithPadding(chunks: Uint8Array[]): Promise<void> {
    if (!this.sendPadding) {
      await this.writeSocket(chunks);
      return;
    }
    const factory = this.opts.padding();
    const total = chunks.reduce((n, b) => n + b.length, 0);
    let merged: Uint8Array | null = null;
    const merge = (): Uint8Array => {
      if (merged) return merged;
      merged = new Uint8Array(total);
      let off = 0;
      for (const b of chunks) {
        merged.set(b, off);
        off += b.length;
      }
      return merged;
    };
    const pkt = ++this.pktCounter;
    if (pkt >= factory.stop) {
      this.sendPadding = false;
      await this.writeSocket(chunks);
      return;
    }
    const sizes = generateRecordPayloadSizes(factory, pkt, this.rnd);
    if (sizes.length === 0) {
      await this.writeSocket(chunks);
      return;
    }
    const plan = planChunks(sizes, total);
    let off = 0;
    for (const step of plan.steps) {
      const out: Uint8Array[] = [];
      if (step.write > 0) {
        out.push(merge().subarray(off, off + step.write));
        off += step.write;
      }
      if (step.wasteLen > 0) out.push(makeWasteFrame(step.wasteLen));
      if (out.length > 0) await this.writeSocket(out);
    }
    if (off < total) {
      await this.writeSocket([merge().subarray(off)]);
    }
  }

  close(): void {
    this.die('local close');
  }
}

interface PaddingJob extends WriteJob {
  padding?: boolean;
  src?: Uint8Array[];
}

/** 单条代理流（类 net.Conn Promise 化读写） */
export class AnytlsStream {
  readonly sid: number;
  private sess: AnytlsSession;
  private recvChunks: Uint8Array[] = [];
  private recvSize = 0;
  private waiters: { resolve(data: Uint8Array): void; reject(e: Error): void; want: number }[] = [];
  private eof = false;
  private err: string | null = null;
  private synackWaiters: ((ok: boolean) => void)[] = [];
  private closed = false;
  target: SocksAddr | null = null;
  bytesIn = 0;
  bytesOut = 0;

  constructor(sid: number, sess: AnytlsSession) {
    this.sid = sid;
    this.sess = sess;
  }

  /** 发代理目标地址（SOCKSAddr）——OpenStream 后必须首先调用 */
  async writeTarget(addr: SocksAddr): Promise<void> {
    this.target = addr;
    const encoded = encodeSocksAddr(addr);
    await this.sess.writeStreamData(this.sid, encoded);
    this.bytesOut += encoded.length;
  }

  write(data: Uint8Array): Promise<number> {
    if (this.closed || this.err || this.eof) throw new Error(`stream ${this.sid} closed`);
    this.bytesOut += data.length;
    return this.sess.writeStreamData(this.sid, data);
  }

  /** 读最多 length 字节（有数据即返回；EOF 抛 EofError） */
  read(length = 65536): Promise<Uint8Array> {
    if (this.recvChunks.length > 0) {
      return Promise.resolve(this.takeFromBuffer(length));
    }
    if (this.err) return Promise.reject(new Error(this.err));
    if (this.eof) return Promise.reject(new EofError());
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject, want: length });
    });
  }

  private takeFromBuffer(length: number): Uint8Array {
    const out: Uint8Array[] = [];
    let taken = 0;
    while (this.recvChunks.length > 0 && taken < length) {
      const first = this.recvChunks[0] as Uint8Array;
      if (taken + first.length <= length) {
        out.push(first);
        taken += first.length;
        this.recvChunks.shift();
      } else {
        const need = length - taken;
        out.push(first.subarray(0, need));
        this.recvChunks[0] = first.subarray(need);
        taken = length;
      }
    }
    this.recvSize -= taken;
    const merged = new Uint8Array(taken);
    let off = 0;
    for (const c of out) {
      merged.set(c, off);
      off += c.length;
    }
    return merged;
  }

  onData(data: Uint8Array): void {
    this.bytesIn += data.length;
    this.recvChunks.push(data);
    this.recvSize += data.length;
    if (this.recvSize > MAX_STREAM_BUFFER) {
      // 消费方停读且缓冲越界：按 design §2.5 断开该流（防 OOM）
      this.err = 'receive buffer overflow';
      this.eof = true;
      this.recvChunks.splice(0);
      this.recvSize = 0;
      for (const w of this.waiters.splice(0)) w.reject(new Error(this.err));
      this.sess.streamClosed(this.sid);
      return;
    }
    // 唤醒等待者
    while (this.waiters.length > 0 && this.recvChunks.length > 0) {
      const w = this.waiters.shift() as (typeof this.waiters)[number];
      w.resolve(this.takeFromBuffer(w.want));
    }
  }

  onSynack(): void {
    for (const w of this.synackWaiters.splice(0)) w(true);
  }

  /** 等 SYNACK（v2）；超时返回 false */
  waitSynack(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.synackWaiters.push(resolve);
      setTimeout(() => {
        const idx = this.synackWaiters.indexOf(resolve);
        if (idx >= 0) {
          this.synackWaiters.splice(idx, 1);
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  remoteClosed(reason: string): void {
    if (reason.startsWith('remote:')) {
      // SYNACK 错误报告：保留文本供读端读取（design §1.4）
      this.err = reason;
    }
    if (this.eof) {
      this.drainWaitersThenEof();
      return;
    }
    this.eof = true;
    this.drainWaitersThenEof();
    this.maybeFinish();
  }

  private drainWaitersThenEof(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift() as (typeof this.waiters)[number];
      if (this.recvChunks.length > 0) {
        w.resolve(this.takeFromBuffer(w.want));
      } else {
        w.reject(new EofError());
      }
    }
    this.maybeFinish();
  }

  private closeHooks: (() => void)[] = [];
  private finished = false;

  addCloseHook(hook: () => void): void {
    this.closeHooks.push(hook);
  }

  removeCloseHook(hook: () => void): void {
    const idx = this.closeHooks.indexOf(hook);
    if (idx >= 0) this.closeHooks.splice(idx, 1);
  }

  private fireCloseHooks(): void {
    for (const h of this.closeHooks.splice(0)) h();
  }

  /** 流彻底结束（本端 close 或对端 FIN 且缓冲排空）时触发钩子 */
  private maybeFinish(): void {
    if (this.eof && this.recvChunks.length === 0 && this.waiters.length === 0 && !this.finished) {
      this.finished = true;
      this.fireCloseHooks();
    }
  }

  /** 本端主动关闭：发 FIN */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.eof = true;
    for (const w of this.waiters.splice(0)) w.reject(new EofError());
    this.sess.streamClosed(this.sid);
    if (!this.finished) {
      this.finished = true;
      this.fireCloseHooks();
    }
  }
}

export class EofError extends Error {
  constructor() {
    super('eof');
    this.name = 'EofError';
  }
}

/** 便于测试导出常量 */
export const SESSION_CONSTS = { HEADER_SIZE, MAX_STREAM_BUFFER };
