/** macOS 系统代理生命周期；仅在启停时执行，不参与转发。 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HOME_CONFIG_DIR } from '../config/paths.ts';
import { acquireSystemLock, type AcquireSystemLock } from './lock.ts';
import { processAlive, processBirth } from './process.ts';
import { runLockedCommand } from './command.ts';

export type NetworkRunner = (args: string[], fd?: number) => Promise<string>;
interface ProxyState { enabled: boolean; server: string; port: number; authenticated: boolean }
interface ServiceState {
  name: string;
  http: ProxyState;
  https: ProxyState;
  socks: ProxyState;
  pac: { enabled: boolean; url: string };
  discovery: boolean;
}
interface Journal {
  version: 1;
  pid: number;
  birth?: string;
  httpPort: number;
  socksPort: number;
  services: ServiceState[];
  restoring?: string[];
  restoreFailed?: string;
}
const PROXIES = [
  { key: 'http', command: 'webproxy' },
  { key: 'https', command: 'securewebproxy' },
  { key: 'socks', command: 'socksfirewallproxy' },
] as const;

export async function runNetworksetup(args: string[], fd?: number): Promise<string> {
  const out = await runLockedCommand(['/usr/sbin/networksetup', ...args], fd);
  if (/^(?:Error:|\*\* Error:)/m.test(out)) {
    throw new Error(`networksetup ${args[0]} failed: ${out.trim().slice(0, 200)}`);
  }
  return out;
}

function value(text: string, key: string): string {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(`${key}:`));
  if (line === undefined) throw new Error(`invalid networksetup response: missing ${key}`);
  return line.slice(key.length + 1).trim();
}
function enabled(text: string, key: string, yes: string, no: string): boolean {
  const raw = value(text, key);
  if (raw !== yes && raw !== no) throw new Error(`invalid networksetup flag: ${key}`);
  return raw === yes;
}
function parseProxy(text: string): ProxyState {
  const raw = value(text, 'Port');
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) throw new Error('invalid proxy port');
  return {
    enabled: enabled(text, 'Enabled', 'Yes', 'No'),
    server: value(text, 'Server'), port,
    authenticated: enabled(text, 'Authenticated Proxy Enabled', '1', '0'),
  };
}
const portValid = (port: unknown, min = 1): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port >= min && port <= 65535;
function proxyValid(input: unknown): input is ProxyState {
  if (!input || typeof input !== 'object') return false;
  const p = input as ProxyState;
  return typeof p.enabled === 'boolean' && typeof p.server === 'string' && !p.server.includes('\0') &&
    portValid(p.port, 0) && typeof p.authenticated === 'boolean';
}
function serviceValid(input: unknown): input is ServiceState {
  if (!input || typeof input !== 'object') return false;
  const s = input as ServiceState;
  return typeof s.name === 'string' && s.name.length > 0 && s.name.length <= 200 && !/[\0\r\n]/.test(s.name) &&
    PROXIES.every(({ key }) => proxyValid(s[key])) && typeof s.discovery === 'boolean' &&
    !!s.pac && typeof s.pac.enabled === 'boolean' && typeof s.pac.url === 'string';
}

export class SystemProxyManager {
  private path: string;
  private customRun?: NetworkRunner;
  private lockFd?: number;
  private acquire: AcquireSystemLock;
  readonly supported: boolean;
  constructor(options: {
    path?: string; run?: NetworkRunner; platform?: string; acquire?: AcquireSystemLock;
  } = {}) {
    this.path = options.path ?? join(HOME_CONFIG_DIR(), 'system-proxy.json');
    this.customRun = options.run;
    this.acquire = options.acquire ?? acquireSystemLock;
    this.supported = (options.platform ?? process.platform) === 'darwin';
  }

  ownsRecoveryState(): boolean { return this.read()?.pid === process.pid; }

  /** 恢复失败残留：返回失败项描述；无残留或未接管返回 null */
  pendingRestoreFailure(): string | null {
    if (!this.supported || !existsSync(this.path)) return null;
    const state = this.read();
    return state?.restoreFailed ?? null;
  }
  private run(args: string[]): Promise<string> {
    return this.customRun ? this.customRun(args, this.lockFd) : runNetworksetup(args, this.lockFd);
  }

  private read(): Journal | null {
    if (!existsSync(this.path)) return null;
    if (statSync(this.path).size > 1024 * 1024) throw new Error('system proxy snapshot too large');
    const state = JSON.parse(readFileSync(this.path, 'utf8')) as Journal | null;
    if (!state || state.version !== 1 || !Number.isInteger(state.pid) || state.pid <= 0 ||
      !portValid(state.httpPort) || !portValid(state.socksPort) || !Array.isArray(state.services) ||
      state.services.length === 0 || state.services.length > 128 || !state.services.every(serviceValid) ||
      (state.birth !== undefined && (typeof state.birth !== 'string' || state.birth.length > 200)) ||
      (state.restoreFailed !== undefined && typeof state.restoreFailed !== 'string') ||
      (state.restoring !== undefined && (!Array.isArray(state.restoring) ||
        state.restoring.length > state.services.length * 3 || state.restoring.some((key) =>
          typeof key !== 'string' || !/^\d+:(http|https|socks)$/.test(key) ||
          Number(key.split(':')[0]) >= state.services.length)))) {
      throw new Error('invalid system proxy snapshot');
    }
    return state;
  }

  private save(state: Journal): void {
    const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }

  private async lock<T>(action: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lease = await this.acquire(`${this.path}.lock`);
    this.lockFd = lease.fd;
    try { return await action(); } finally { this.lockFd = undefined; await lease.release(); }
  }

  private async services(all = false): Promise<string[]> {
    const lines = (await this.run(['-listallnetworkservices'])).split(/\r?\n/).slice(1);
    const names = lines.filter((name) => name.trim() && (all || !name.startsWith('*')))
      .map((name) => name.replace(/^\*/, ''));
    if (names.length > 128 || names.some((name) => !name || /[\0\r\n]/.test(name))) {
      throw new Error('invalid network service list');
    }
    return names;
  }

  private async snapshot(name: string): Promise<ServiceState> {
    const [http, https, socks, pac, discovery] = await Promise.all([
      ...PROXIES.map(({ command }) => this.run([`-get${command}`, name])),
      this.run(['-getautoproxyurl', name]), this.run(['-getproxyautodiscovery', name]),
    ]);
    return {
      name, http: parseProxy(http!), https: parseProxy(https!), socks: parseProxy(socks!),
      pac: { enabled: enabled(pac!, 'Enabled', 'Yes', 'No'), url: value(pac!, 'URL') },
      discovery: enabled(discovery!, 'Auto Proxy Discovery', 'On', 'Off'),
    };
  }

  async enable(httpPort: number, socksPort: number): Promise<boolean> {
    if (!this.supported) return false;
    if (!portValid(httpPort) || !portValid(socksPort)) throw new Error('invalid system proxy ports');
    return this.lock(async () => {
      const previous = this.read();
      if (previous) {
        if (await processAlive(previous.pid, previous.birth)) {
          throw new Error('system proxy already managed by a running process');
        }
        await this.restore(previous);
      }
      const services: ServiceState[] = [];
      for (const name of await this.services()) services.push(await this.snapshot(name));
      if (services.length === 0) throw new Error('no enabled network services');
      if (services.some((s) => PROXIES.some(({ key }) => s[key].authenticated))) {
        throw new Error('authenticated system proxy cannot be restored safely; use --no-system-proxy');
      }
      const state: Journal = {
        version: 1, pid: process.pid, birth: await processBirth(process.pid), httpPort, socksPort, services,
      };
      this.save(state);
      try {
        for (const service of services) {
          await this.run(['-setautoproxystate', service.name, 'off']);
          await this.run(['-setproxyautodiscovery', service.name, 'off']);
          for (const { key, command } of PROXIES) {
            await this.run([`-set${command}`, service.name, '127.0.0.1', String(key === 'socks' ? socksPort : httpPort),
              'off']);
          }
        }
      } catch (e) {
        try { await this.restore(state); } catch (_rollback) {
          throw new Error('system proxy setup and rollback failed; recovery snapshot retained');
        }
        throw e;
      }
      return true;
    });
  }

  async disable(ownerPid?: number): Promise<boolean> {
    if (!this.supported || !existsSync(this.path)) return false;
    return this.lock(async () => {
      const state = this.read();
      if (!state || (ownerPid !== undefined && state.pid !== ownerPid)) return false;
      await this.restore(state);
      return true;
    });
  }

  private async restore(state: Journal): Promise<void> {
    const names = new Set(await this.services(true));
    const failed: string[] = [];
    for (const [index, saved] of state.services.entries()) {
      if (!names.has(saved.name)) continue;
      let current: ServiceState;
      try { current = await this.snapshot(saved.name); } catch (_e) { failed.push(saved.name); continue; }
      for (const { key, command } of PROXIES) {
        const before = saved[key];
        const now = current[key];
        const ownedPort = key === 'socks' ? state.socksPort : state.httpPort;
        const token = `${index}:${key}`;
        const originalAddress = now.server === before.server && now.port === before.port;
        const owned = now.server === '127.0.0.1' && now.port === ownedPort;
        const pending = state.restoring?.includes(token) && originalAddress;
        if ((originalAddress && now.enabled === before.enabled && now.authenticated === before.authenticated) ||
          now.authenticated || (!owned && !pending)) continue;
        try {
          state.restoring ??= [];
          if (!state.restoring.includes(token)) state.restoring.push(token);
          this.save(state);
          if (!originalAddress) {
            await this.run([`-set${command}`, saved.name, before.server, String(before.port), 'off']);
          }
          await this.run([`-set${command}state`, saved.name, before.enabled ? 'on' : 'off']);
          state.restoring = state.restoring.filter((item) => item !== token);
        } catch (_e) { failed.push(`${saved.name}/${key}`); }
      }
      if (!current.pac.enabled && saved.pac.enabled && current.pac.url === saved.pac.url) {
        try { await this.run(['-setautoproxystate', saved.name, 'on']); }
        catch (_e) { failed.push(`${saved.name}/PAC`); }
      }
      if (!current.discovery && saved.discovery) {
        try { await this.run(['-setproxyautodiscovery', saved.name, 'on']); }
        catch (_e) { failed.push(`${saved.name}/discovery`); }
      }
    }
    if (failed.length) {
      state.restoreFailed = failed.join(', ');
      this.save(state);
      throw new Error(`system proxy restore incomplete: ${failed.join(', ')}`);
    }
    rmSync(this.path);
  }
}

export const createSystemProxyManager = (): SystemProxyManager => new SystemProxyManager();
