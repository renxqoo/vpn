/** start 子命令（原 main.ts 的启动职责；design.md §1.1 第三批拆分）。 */

import { logger, setLogLevel } from './core/log.ts';
import { parseClashConfig } from './config/clash.ts';
import { defaultStore, loadSubscription } from './config/subscription.ts';
import { cacheDirectory, resolveConfigSource } from './config/paths.ts';
import { App } from './app.ts';
import type { ClashConfig } from './config/clash.ts';

const log = logger('start');

const EMPTY_CONFIG: ClashConfig = {
  httpPort: 7890,
  socksPort: 7891,
  mode: 'rule',
  logLevel: 'info',
  apiAddr: '127.0.0.1:9090',
  apiSecret: '',
  proxies: [],
  groups: [],
  rules: [{ type: 'MATCH', payload: '', target: 'DIRECT', noResolve: false, raw: 'MATCH,DIRECT' }],
  ruleProviders: new Map(),
};

function parseStartArgs(argv: string[]): { port?: number; socksPort?: number; apiPort?: number; direct: boolean } {
  const out: { port?: number; socksPort?: number; apiPort?: number; direct: boolean } = { direct: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--socks-port') out.socksPort = Number(argv[++i]);
    else if (a === '--api-port') out.apiPort = Number(argv[++i]);
    else if (a === '--direct') out.direct = true;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

export async function runStart(argv: string[]): Promise<void> {
  const args = parseStartArgs(argv);
  const cacheDir = cacheDirectory();
  await Bun.write(`${cacheDir}/.keep`, '').catch(() => {});

  const src = await resolveConfigSource();
  const overrides = {
    httpPort: args.port ?? src.httpPort,
    socksPort: args.socksPort ?? src.socksPort,
    apiPort: args.apiPort ?? src.apiPort,
  };

  let config: ClashConfig;
  if (args.direct || !src.subscriptionUrl) {
    if (!args.direct) {
      log.warn('订阅地址为空（.env 与 ~/.vpn/config.yaml 均未配置）——以直连模式启动');
      log.warn('写入订阅: bun-clash config set-subscription <URL>，然后重启');
    }
    config = { ...EMPTY_CONFIG, httpPort: overrides.httpPort ?? 7890, socksPort: overrides.socksPort ?? 7891 };
  } else {
    const text = await loadSubscription(src.subscriptionUrl, defaultStore(cacheDir));
    config = parseClashConfig(text);
  }
  setLogLevel(config.logLevel === 'silent' ? 'warn' : 'info');

  const app = new App({ config, cacheDir, overrides });
  await app.start();
  log.info(
    `配置来源: ${src.source === 'dotenv' ? '.env（dev）' : src.source === 'home' ? '~/.vpn/config.yaml' : '空（直连）'}；` +
      `模式: ${config.mode === 'rule' ? '规则' : config.mode === 'global' ? '全局' : '直连'}`,
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
