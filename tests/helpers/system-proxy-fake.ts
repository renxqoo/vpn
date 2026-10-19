/** 在内存中模拟 networksetup，测试不会调用宿主网络设置。 */
import { acquireSystemLock, type AcquireSystemLock } from '../../src/system/lock.ts';

const locks = new Set<string>();
export const testSystemLock: AcquireSystemLock = process.platform === 'darwin' ? acquireSystemLock : async (path) => {
  if (locks.has(path)) throw new Error('system proxy operation busy');
  locks.add(path);
  return { release: async () => { locks.delete(path); } };
};

export interface FakeProxy { enabled: boolean; server: string; port: number; authenticated: boolean }
export interface FakeService {
  http: FakeProxy; https: FakeProxy; socks: FakeProxy;
  pac: { enabled: boolean; url: string }; discovery: boolean;
}
export function initialService(): FakeService {
  const proxy = (): FakeProxy => ({ enabled: false, server: '', port: 0, authenticated: false });
  return {
    http: { ...proxy(), enabled: true, server: 'previous.example', port: 8888 },
    https: proxy(), socks: proxy(), pac: { enabled: true, url: 'https://previous.example/proxy.pac' },
    discovery: true,
  };
}
export class FakeNetwork {
  services: Record<string, FakeService> = { 'Wi-Fi': initialService() };
  disabled = new Set<string>();
  calls: string[][] = [];
  fail?: (args: string[]) => boolean;
  changed?: () => void;
  readonly run = async (args: string[]): Promise<string> => {
    this.calls.push([...args]);
    if (this.fail?.(args)) throw new Error('injected networksetup failure');
    if (args[0] === '-listallnetworkservices') {
      return 'An asterisk (*) denotes that a network service is disabled.\n' +
        Object.keys(this.services).map((name) => (this.disabled.has(name) ? '*' : '') + name).join('\n') + '\n';
    }
    const service = this.services[args[1]!];
    if (!service) throw new Error('unknown service');
    const definitions = [['http', 'webproxy'], ['https', 'securewebproxy'], ['socks', 'socksfirewallproxy']] as const;
    for (const [key, command] of definitions) {
      const proxy = service[key];
      if (args[0] === `-get${command}`) {
        return `Enabled: ${proxy.enabled ? 'Yes' : 'No'}\nServer: ${proxy.server}\nPort: ${proxy.port}\n` +
          `Authenticated Proxy Enabled: ${proxy.authenticated ? '1' : '0'}\n`;
      }
      if (args[0] === `-set${command}`) {
        Object.assign(proxy, { enabled: true, server: args[2], port: Number(args[3]), authenticated: false });
        this.changed?.();
        return '';
      }
      if (args[0] === `-set${command}state`) {
        proxy.enabled = args[2] === 'on';
        this.changed?.();
        return '';
      }
    }
    if (args[0] === '-getautoproxyurl') {
      return `URL: ${service.pac.url}\nEnabled: ${service.pac.enabled ? 'Yes' : 'No'}\n`;
    }
    if (args[0] === '-getproxyautodiscovery') return `Auto Proxy Discovery: ${service.discovery ? 'On' : 'Off'}\n`;
    if (args[0] === '-setautoproxystate') service.pac.enabled = args[2] === 'on';
    else if (args[0] === '-setproxyautodiscovery') service.discovery = args[2] === 'on';
    else throw new Error(`unsupported fake command ${args[0]}`);
    this.changed?.();
    return '';
  };
}
