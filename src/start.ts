import { join } from 'node:path';
import { logger, setLogLevel } from './core/log.ts';
import { buildRuntimeConfig, collectFileInputs, mergeSource } from './config/settings.ts';
import { cacheDirectory } from './config/paths.ts';
import { defaultStore, loadSubscription } from './config/subscription.ts';
import { App } from './app.ts';

const log = logger('start');

interface StartArgs {
  port?: number;
  socksPort?: number;
  apiPort?: number;
  direct: boolean;
}

export function parseStartArgs(argv: string[]): StartArgs {
  const out: StartArgs = { direct: false };
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
  await Bun.write(join(cacheDir, '.keep'), '').catch(() => {});

  const files = await collectFileInputs();
  const settings = mergeSource(files);
  let subscriptionYaml: string | null = null;
  if (settings.subscriptionUrl && !args.direct) {
    subscriptionYaml = await loadSubscription(settings.subscriptionUrl, defaultStore(cacheDir));
  }

  const runtime = await buildRuntimeConfig({ files, subscriptionYaml, cli: args });
  const raw = runtime.config.logLevel;
  const allowed = new Set(['debug', 'info', 'warn', 'error', 'silent']);
  setLogLevel(allowed.has(raw as never) ? (raw as 'info') : 'info');

  if (runtime.needsSubscriptionGuide) {
    log.warn('订阅地址为空（.env 与 ~/.vpn/config.yaml 均未配置）——以直连模式启动');
    log.warn('写入订阅: bun-clash config set-subscription <URL>，然后重启');
  }

  const app = new App({ config: runtime.config, cacheDir, overrides: runtime.overrides });
  await app.start();
  const modeLabel = { rule: '规则', global: '全局', direct: '直连' }[app.currentMode()] ?? app.currentMode();
  log.info(`配置来源: ${runtime.sourceLabel}；模式: ${modeLabel}`);

  process.on('unhandledRejection', (reason: unknown) => {
    log.error(`unhandled rejection: ${String(reason).slice(0, 200)}`);
  });

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
