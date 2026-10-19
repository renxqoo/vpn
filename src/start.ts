import { join } from 'node:path';
import { logger, setLogLevel } from './core/log.ts';
import { buildRuntimeConfig, collectFileInputs, mergeSource } from './config/settings.ts';
import { cacheDirectory } from './config/paths.ts';
import { defaultStore, loadSubscription } from './config/subscription.ts';
import { clearController, readRunningController, writeController } from './config/controller.ts';
import { createSystemProxyManager } from './system/proxy.ts';
import { App } from './app.ts';
import { writeSelectedNode } from './config/nodes.ts';

const log = logger('start');

interface StartArgs {
  port?: number;
  socksPort?: number;
  apiPort?: number;
  direct: boolean;
  systemProxy: boolean;
}

export function parseStartArgs(argv: string[]): StartArgs {
  const out: StartArgs = { direct: false, systemProxy: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--socks-port') out.socksPort = Number(argv[++i]);
    else if (a === '--api-port') out.apiPort = Number(argv[++i]);
    else if (a === '--direct') out.direct = true;
    else if (a === '--no-system-proxy') out.systemProxy = false;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  for (const port of [out.port, out.socksPort, out.apiPort]) {
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new Error('监听端口必须是 0–65535 的整数（0 表示自动分配）');
    }
  }
  return out;
}

export async function runStart(argv: string[]): Promise<void> {
  const args = parseStartArgs(argv);
  if (await readRunningController()) throw new Error('内核已在运行，请先运行 bun-clash stop');
  const systemProxy = createSystemProxyManager();
  const cacheDir = cacheDirectory();
  await Bun.write(join(cacheDir, '.keep'), '').catch(() => {});

  const loadRuntime = async () => {
    const files = await collectFileInputs();
    const settings = mergeSource(files);
    let subscriptionYaml: string | null = null;
    if (settings.subscriptionUrl && !args.direct) {
      subscriptionYaml = await loadSubscription(
        settings.subscriptionUrl, defaultStore(cacheDir, settings.subscriptionUrl),
      );
    }
    const runtime = await buildRuntimeConfig({ files, subscriptionYaml, cli: args });
    return { runtime, settings };
  };
  const initial = await loadRuntime();
  const runtime = initial.runtime;
  const raw = runtime.config.logLevel;
  const allowed = new Set(['debug', 'info', 'warn', 'error', 'silent']);
  setLogLevel(allowed.has(raw as never) ? (raw as 'info') : 'info');

  if (runtime.needsSubscriptionGuide) {
    log.warn('订阅地址为空（.env 与 ~/.vpn/config.yaml 均未配置）——以直连模式启动');
    log.warn('写入订阅: bun-clash config set-subscription <URL>，然后重启');
  }

  let startup: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | null = null;
  const prepareShutdown = async () => {
    await startup.catch(() => {});
    await systemProxy.disable(process.pid);
  };
  const shutdown = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      await prepareShutdown();
      await app.stop();
      await clearController();
      log.info('系统代理已恢复，内核已停止');
      process.exit(0);
    })().catch((e: unknown) => { stopping = null; throw e; });
    return stopping;
  };
  const app = new App({
    config: runtime.config,
    cacheDir,
    overrides: runtime.overrides,
    disableSystemProxy: async () => { await startup; await systemProxy.disable(); },
    prepareShutdown,
    shutdown,
    reloadConfig: async () => {
      const next = await loadRuntime();
      if (!args.direct && next.settings.selectedNode && !next.runtime.settings.selectedNode) {
        await writeSelectedNode(null);
      }
      await app.reload(next.runtime.config);
    },
  });
  const signalShutdown = () => {
    void shutdown().catch((e: unknown) => log.error(`关闭失败，内核保留运行，请修复后重试 stop：${String(e)}`));
  };
  process.on('SIGINT', signalShutdown);
  process.on('SIGTERM', signalShutdown);
  startup = (async () => {
    try {
      await app.start();
      if (args.systemProxy) {
        const enabled = await systemProxy.enable(app.httpPort, app.socksPortForTest);
        if (enabled) {
          log.info(`系统代理已启用：HTTP/HTTPS 127.0.0.1:${app.httpPort}，SOCKS ${app.socksPortForTest}`);
        } else log.warn('当前平台未实现系统代理自动接管，请手动设置 HTTP/SOCKS 端口');
      }
      await writeController(app.apiPortForTest, runtime.config.apiSecret);
      if (initial.settings.selectedNode && !runtime.settings.selectedNode && !args.direct) {
        await writeSelectedNode(null);
      }
    } catch (e) {
      if (systemProxy.ownsRecoveryState()) {
        try { await systemProxy.disable(process.pid); } catch (_restore) {
          await writeController(app.apiPortForTest, runtime.config.apiSecret);
          log.error('系统代理恢复失败，已保留内核与恢复快照；修复权限后运行 proxy off / stop');
          return;
        }
      }
      await app.stop();
      await clearController();
      throw e;
    }
  })();
  await startup;
  const modeLabel = { rule: '规则', global: '全局', direct: '直连' }[app.currentMode()] ?? app.currentMode();
  log.info(`配置来源: ${runtime.sourceLabel}；模式: ${modeLabel}`);

  process.on('unhandledRejection', (reason: unknown) => {
    log.error(`unhandled rejection: ${String(reason).slice(0, 200)}`);
  });

}
