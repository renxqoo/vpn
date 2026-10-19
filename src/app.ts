/**
 * App 装配（design.md §2）：配置 → 出站/组 → 规则引擎 → 入站/API。
 */

import { join } from 'node:path';
import { logger } from './core/log.ts';
import { parseClashConfig, type ClashConfig } from './config/clash.ts';
import { loadSubscription } from './config/subscription.ts';
import { DirectOutbound } from './outbound/direct.ts';
import { AnytlsOutbound } from './outbound/anytls/index.ts';
import { AnytlsClient } from './outbound/anytls/client.ts';
import { RuleEngine } from './rules/index.ts';
import { RuleProviders } from './rules/providers.ts';
import { loadGeoip } from './rules/geoip.ts';
import { readTextBounded } from './core/fetchbounded.ts';
import { buildGroup } from './rules/groups.ts';
import { SelectGroup } from './rules/groups.ts';
import { HttpInbound } from './inbound/http.ts';
import { Socks5Inbound } from './inbound/socks5.ts';
import { RestApi } from './api/server.ts';
import { ConnectionTracker } from './core/connections.ts';
import { CLIENT_NAME } from './core/version.ts';
import type { Outbound } from './core/types.ts';

const log = logger('app');

export interface AppOptions {
  config: ClashConfig;
  cacheDir: string;
  overrides?: { httpPort?: number; socksPort?: number; apiPort?: number };
}

export class App {
  private inbounds: (HttpInbound | Socks5Inbound)[] = [];
  private api: RestApi | null = null;
  private outbounds = new Map<string, Outbound>();
  private providers: RuleProviders | null = null;
  private engine: RuleEngine | null = null;
  tracker = new ConnectionTracker();
  private opts: AppOptions;
  private runtimeMode: ClashConfig['mode'];
  private readonly groupLabel = '🚀 节点选择';

  constructor(opts: AppOptions) {
    this.opts = opts;
    this.runtimeMode = opts.config.mode;
  }

  /** 当前代理模式（运行时可被 PATCH /configs 改变） */
  currentMode(): ClashConfig['mode'] {
    return this.runtimeMode;
  }

  /** 热切换模式；返回是否成功 */
  setMode(mode: ClashConfig['mode']): boolean {
    if (mode !== 'rule' && mode !== 'global' && mode !== 'direct') return false;
    this.runtimeMode = mode;
    log.info(`mode switched to ${mode}`);
    return true;
  }

  async start(): Promise<void> {
    const cfg = this.opts.config;
    const cache = this.opts.cacheDir;

    // 出站
    const direct = new DirectOutbound('DIRECT');
    this.outbounds.set('DIRECT', direct);
    for (const p of cfg.proxies) {
      if (p.kind !== 'anytls') continue;
      const client = new AnytlsClient(p.name, {
        host: p.server,
        port: p.port,
        password: p.password,
        sni: p.sni,
        skipCertVerify: p.skipCertVerify,
        idleSessionCheckIntervalMs: p.idleSessionCheckIntervalSec * 1000,
        idleSessionTimeoutMs: p.idleSessionTimeoutSec * 1000,
        minIdleSession: p.minIdleSession,
        clientName: CLIENT_NAME,
      });
      this.outbounds.set(p.name, new AnytlsOutbound(p.name, client));
    }

    // 组（后声明的组可引用先声明的组与节点；同名组幂等）
    const groupOutbounds = new Map<string, Outbound>();
    const unresolvable = new Set<string>(
      cfg.proxies.filter((p) => p.kind === 'unknown').map((p) => p.name),
    );
    for (let pass = 0; pass < cfg.groups.length; pass++) {
      let progressed = false;
      for (const g of cfg.groups) {
        if (groupOutbounds.has(g.name)) continue;
        const members = new Map<string, Outbound>();
        const pending: string[] = [];
        for (const m of g.proxies) {
          const o = this.outbounds.get(m) ?? groupOutbounds.get(m);
          if (o) members.set(m, o);
          else if (!unresolvable.has(m) && cfg.groups.some((x) => x.name === m)) pending.push(m);
        }
        const pendingStillPossible = pending.some(
          (m) => !groupOutbounds.has(m) && cfg.groups.some((x) => x.name === m && !groupOutbounds.has(x.name)),
        );
        if (pending.length > 0 && pendingStillPossible && pass < cfg.groups.length - 1) {
          continue; // 有成员引用了尚未构建的组：等下一轮（部分成员组先不定形）
        }
        const missing = g.proxies.filter((m) => !members.has(m));
        const skipped = missing.filter((m) => unresolvable.has(m));
        if (skipped.length > 0) {
          log.warn(`group '${g.name}': unavailable members skipped: ${skipped.join(', ')}`);
        }
        if (members.size === 0) continue;
        const built = buildGroup(g, members);
        groupOutbounds.set(g.name, built);
        this.outbounds.set(g.name, built);
        progressed = true;
      }
      if (!progressed) break;
    }
    for (const g of cfg.groups) {
      if (!groupOutbounds.has(g.name)) {
        log.warn(`group '${g.name}' not built (no usable members)`);
      }
    }

    // url-test/fallback 启动探测
    for (const o of groupOutbounds.values()) {
      if (o instanceof Object && 'start' in o && typeof (o as { start(): void }).start === 'function') {
        (o as unknown as { start(): void }).start();
      }
    }

    // 规则提供者 + geoip + 引擎
    this.providers = new RuleProviders(cfg.ruleProviders, {
      cacheDir: () => cache,
      fetch: async (u: string) => {
        const r = await fetch(u, {
          headers: { 'user-agent': 'clash-verge/v2.0.0' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return readTextBounded(r);
      },
      readFile: async (p: string) => {
        const f = Bun.file(p);
        return (await f.exists()) ? f.text() : null;
      },
      now: () => Date.now(),
    });
    // providers 后台加载（不阻塞启动；引擎持有 live Map，每轮刷新后回调确认）
    this.providers.subscribe(() => {
      if (this.providers !== null && this.providers.liveView().size > 0) {
        log.info(`rule providers available: ${this.providers.liveView().size}`);
      }
    });
    void this.providers.loadAll().then(() => {
      log.info('rule providers loaded');
    });
    const geoip = await loadGeoip(cfg.geoipUrl, join(cache, 'geoip.mmdb'));
    const finalTarget = cfg.rules.filter((r) => r.type === 'MATCH').length > 0 ? '' : 'DIRECT';
    this.engine = new RuleEngine({
      rules: cfg.rules,
      providers: this.providers.liveView(),
      geoip: geoip ? (ip: string) => geoip.country(ip) : null,
      final: finalTarget === '' ? 'DIRECT' : finalTarget,
    });
    if (geoip) log.info('geoip active');
    else log.warn('geoip disabled (GEOIP rules will not match)');

    // 入站
    const httpPort = this.opts.overrides?.httpPort ?? cfg.httpPort;
    const socksPort = this.opts.overrides?.socksPort ?? cfg.socksPort;
    const routerWrap = {
      resolve: (ctx: { host: string; port: number; isIp: boolean }) => {
        const mode = this.runtimeMode;
        if (mode === 'direct') return { outbound: 'DIRECT' } as const;
        if (mode === 'global') {
          // 全局模式：优先 select 组当前选中（含 selected-node），否则第一个 anytls 出站
          const group = this.outbounds.get(this.groupLabel) as SelectGroup | undefined;
          if (group && typeof group.current === 'function') {
            const member = group.current();
            if (member && member !== 'DIRECT') return { outbound: member } as const;
          }
          const firstProxy = cfg.proxies.find((p) => p.kind === 'anytls');
          return { outbound: firstProxy ? firstProxy.name : 'DIRECT' } as const;
        }
        return this.engine!.resolve(ctx);
      },
    };
    const outboundOf = (name: string) => this.outbounds.get(name);
    type OpenInfo = Parameters<NonNullable<ConstructorParameters<typeof HttpInbound>[0]['onOpen']>>[0];
    const onOpen = (info: OpenInfo) => {
      this.tracker.open({
        id: info.id,
        protocol: 'http',
        host: info.host,
        destinationIP: '',
        port: info.port,
        chains: info.chain,
        start: Date.now(),
        meter: info.meter,
        close: info.close,
      });
    };
    const onClose = (id: string) => {
      const c = this.tracker.get(id);
      if (c) this.tracker.close(id);
    };
    const http = new HttpInbound({ port: httpPort, router: routerWrap, outboundOf, onOpen, onClose });
    const socks = new Socks5Inbound({ port: socksPort, router: routerWrap, outboundOf, onOpen, onClose });
    await http.start();
    await socks.start();
    this.inbounds = [http, socks];

    // API
    this.api = new RestApi({
      tracker: this.tracker,
      loopbackPort: 0,
      outboundOf: (n) => this.outbounds.get(n),
      outboundNames: () => [...this.outbounds.keys()],
      engine: this.engine,
      secret: cfg.apiSecret,
      setMode: (m) => this.setMode(m),
      currentMode: () => this.runtimeMode,
    });
    const apiPort = this.opts.overrides?.apiPort;
    await this.api.start(apiPort !== undefined ? `127.0.0.1:${apiPort}` : cfg.apiAddr);
    log.info(`ready: http=${http.port} socks=${socks.port} api=${this.api.port}`);
  }

  async stop(): Promise<void> {
    for (const ib of this.inbounds) ib.stop();
    this.inbounds = [];
    this.api?.stop();
    this.api = null;
    this.providers?.stop();
    for (const o of this.outbounds.values()) o.close();
    this.outbounds.clear();
    log.info('stopped');
  }

  outboundOf(name: string): Outbound | undefined {
    return this.outbounds.get(name);
  }

  getEngine(): RuleEngine | null {
    return this.engine;
  }

  get httpPort(): number {
    const http = this.inbounds.find((ib) => ib instanceof HttpInbound) as HttpInbound | undefined;
    return http?.port ?? 0;
  }

  /** 测试钩子：API 端口 */
  get apiPortForTest(): number {
    return this.api?.port ?? 0;
  }

  get socksPortForTest(): number {
    const socks = this.inbounds.find((ib) => ib instanceof Socks5Inbound) as Socks5Inbound | undefined;
    return socks?.port ?? 0;
  }
}

/** 从订阅 URL 构建配置并启动 App */
export async function appFromSubscription(
  url: string,
  cacheDir: string,
  opts: Partial<Omit<AppOptions, 'config'>> = {},
): Promise<App> {
  const { defaultStore } = await import('./config/subscription.ts');
  const text = await loadSubscription(url, defaultStore(cacheDir));
  const config = parseClashConfig(text);
  const app = new App({ ...opts, config, cacheDir });
  await app.start();
  return app;
}
