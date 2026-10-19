/**
 * AnyTLS Client（会话池；design.md §1.4 复用策略；对齐 anytls-go client.go）。
 * - 新流优先取空闲池中 seq 最大的会话；池空新建（seq 单调递增）
 * - 流结束且会话未死 → 回池
 * - 周期清理：空闲超阈值且数量 > minIdleSession 才关
 */

import { logger } from '../../core/log.ts';
import { DEFAULT_PADDING_SCHEME, makePaddingFactory, type PaddingFactory } from './padding.ts';
import { AnytlsSession, AnytlsStream } from './session.ts';

const log = logger('anytls:client');

export interface AnytlsClientOptions {
  host: string;
  port: number;
  password: string;
  sni?: string;
  skipCertVerify?: boolean;
  idleSessionCheckIntervalMs?: number;
  idleSessionTimeoutMs?: number;
  minIdleSession?: number;
  clientName: string;
  /** 测试注入：固定随机源 */
  random?: import('../../core/random.ts').RandomSource;
}

/** 单会话承载流上限（复用保守值；超出则新开会话避免单连接过载） */
const MAX_STREAMS_PER_SESSION = 64;

export class AnytlsClient {
  readonly name: string;
  private opts: AnytlsClientOptions;
  private paddingFactory: PaddingFactory;
  private sessions = new Map<number, AnytlsSession>();
  private idle = new Map<number, { session: AnytlsSession; openedTotal: number }>();
  private seqCounter = 0;
  private closed = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(name: string, opts: AnytlsClientOptions) {
    this.name = name;
    this.opts = opts;
    const p = makePaddingFactory(DEFAULT_PADDING_SCHEME);
    if (!p) throw new Error('default padding scheme broken');
    this.paddingFactory = p;
    if (!opts.idleSessionCheckIntervalMs || opts.idleSessionCheckIntervalMs < 5000) {
      this.opts = { ...this.opts, idleSessionCheckIntervalMs: 30000 };
    }
    if (!opts.idleSessionTimeoutMs || opts.idleSessionTimeoutMs < 5000) {
      this.opts = { ...this.opts, idleSessionTimeoutMs: 30000 };
    }
  }

  /** 当前 padding factory（UpdatePaddingScheme 生效后替换） */
  currentPadding(): PaddingFactory {
    return this.paddingFactory;
  }

  private updatePaddingScheme(raw: string): boolean {
    const p = makePaddingFactory(raw);
    if (!p) return false;
    this.paddingFactory = p;
    return true;
  }

  private async createSession(): Promise<AnytlsSession> {
    const seq = ++this.seqCounter;
    // Bun 1.4.3：TLS socket 必须在 open 回调（握手完成后）才能写，否则数据丢失；
    // 这里 open 回调只置 flag + resolve promise，session 构造后放行写队列。
    let session: AnytlsSession | null = null;
    let opened = false;
    let openResolve: (() => void) | null = null;
    const openedPromise = new Promise<void>((r) => (openResolve = r));
    // 建连超时（含 TCP 接受但 TLS 挂死：Bun.connect promise 永不 resolve 的形态）
    const CONNECT_TIMEOUT = 15_000;
    let connectReject: ((e: Error) => void) | null = null;
    const connectFailed = new Promise<never>((_, rej) => {
      connectReject = rej;
    });
    const connectTimer = setTimeout(() => {
      connectReject?.(new Error('connect timeout (tcp or tls handshake)'));
      session?.die('connect timeout');
      try {
        socketPlaceholder?.end();
      } catch (_e) {
        /* noop */
      }
    }, CONNECT_TIMEOUT);
    let socketPlaceholder: Bun.Socket<undefined> | null = null;
    const socket = await Promise.race([Bun.connect({
      hostname: this.opts.host,
      port: this.opts.port,
      tls: {
        rejectUnauthorized: this.opts.skipCertVerify ? false : true,
        serverName: this.opts.sni ?? this.opts.host,
      },
      socket: {
        data(_s, data) {
          session?.feedData(data as Buffer);
        },
        close() {
          session?.die('socket closed');
        },
        end() {
          session?.die('socket ended');
        },
        error(_s, err) {
          session?.die(String(err));
        },
        open() {
          opened = true;
          openResolve?.();
        },
      },
    }), connectFailed]);
    clearTimeout(connectTimer);
    session = new AnytlsSession(socket, seq, this.opts.password, {
      hooks: {
        onDead: () => {
          this.sessions.delete(seq);
          this.idle.delete(seq);
        },
        onUpdatePaddingScheme: (raw) => this.updatePaddingScheme(raw),
        onAlert: (msg) => log.warn(`[${this.name}] server alert: ${msg}`),
      },
      padding: () => this.currentPadding(),
      random: this.opts.random,
      clientName: this.opts.clientName,
    });
    socketPlaceholder = socket;
    if (!opened) await openedPromise; // open 未触发则等（触发了则 promise 已 resolve）
    openResolve = null;
    clearTimeout(connectTimer);
    session.markConnected();
    this.sessions.set(seq, session);
    return session;
  }

  /** 取空闲池中 seq 最大且未超载的会话；死/超载的顺手清理 */
  private takeIdle(): AnytlsSession | null {
    let best: number = -1;
    for (const key of this.idle.keys()) {
      if (key > best) best = key;
    }
    if (best < 0) return null;
    const entry = this.idle.get(best) as { session: AnytlsSession; openedTotal: number };
    this.idle.delete(best);
    if (entry.session.isDead()) return this.takeIdle();
    if (entry.openedTotal >= MAX_STREAMS_PER_SESSION) {
      // 超载会话不再复用：直接关闭（否则它既不在池也不可回收 → socket 泄漏）
      log.debug(`session ${entry.session.seq} at stream cap (${entry.openedTotal}), closing`);
      entry.session.close();
      return this.takeIdle();
    }
    return entry.session;
  }

  private releaseToIdle(session: AnytlsSession, openedTotal: number): void {
    if (session.isDead() || this.closed) return;
    session.idleSince = Date.now();
    this.idle.set(session.seq, { session, openedTotal });
  }

  /** 开一条新流（自动选择/创建会话）；流彻底结束（close hook）时回池 */
  async openStream(): Promise<{ stream: AnytlsStream; done: Promise<void> }> {
    if (this.closed) throw new Error('client closed');
    let session = this.takeIdle();
    if (!session) session = await this.createSession();
    const openedTotal = session.openedStreams + 1;
    let stream;
    try {
      stream = session.openStream();
    } catch (e) {
      // 打开失败（会话死亡竞态）：会话交给 onDead 清理，换一个再试一次
      if (session.isDead()) {
        const retry = await this.openStream();
        return retry;
      }
      throw e;
    }
    const done = new Promise<void>((resolve) => {
      const hook = () => {
        stream.removeCloseHook(hook);
        if (!session || session.isDead()) {
          resolve();
          return;
        }
        this.releaseToIdle(session, openedTotal);
        resolve();
      };
      stream.addCloseHook(hook);
    });
    return { stream, done };
  }

  startCleanup(): void {
    if (this.cleanupTimer) return;
    const interval = this.opts.idleSessionCheckIntervalMs ?? 30000;
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);
  }

  private cleanup(): void {
    const timeout = this.opts.idleSessionTimeoutMs ?? 30000;
    const minIdle = this.opts.minIdleSession ?? 5;
    const now = Date.now();
    const entries = [...this.idle.entries()].sort((a, b) => a[1].session.idleSince - b[1].session.idleSince);
    let active = 0;
    for (const [key, entry] of entries) {
      if (now - entry.session.idleSince >= timeout) {
        if (active < minIdle) {
          entry.session.idleSince = now;
          active++;
          continue;
        }
        this.idle.delete(key);
        entry.session.close();
      } else {
        active++;
      }
    }
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  idleSessionCount(): number {
    return this.idle.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.idle.clear();
  }
}
