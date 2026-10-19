/** config 子命令（从原 main.ts 拆出；design.md §1.1 第三批）。 */

import { DOTENV_PATH, HOME_CONFIG_PATH, setSubscription } from './config/paths.ts';
import { buildRuntimeConfig, collectFileInputs, mergeSource } from './config/settings.ts';
import { cacheDirectory } from './config/paths.ts';
import { defaultStore, loadSubscription } from './config/subscription.ts';
import { writeSelectedNode } from './config/nodes.ts';
import { resolveController } from './config/controller.ts';
import { hotReload } from './config/reload.ts';
import { PROGRAM_VERSION } from './core/version.ts';

function usage(): void {
  console.log(`用法：bun-clash config set-subscription <URL> | show`);
}

export async function runConfigCommand(sub: string[]): Promise<void> {
  const cmd = sub[0];
  if (cmd === 'set-subscription') {
    const url = sub[1];
    if (!url || !/^https:\/\//.test(url)) {
      console.error('订阅地址必须是 https://（明文订阅可被中间人整体替换，已拒绝）');
      console.error('用法: bun-clash config set-subscription <https://...>');
      process.exit(1);
    }
    const path = await setSubscription(url);
    console.log(`订阅地址已写入 ${path}`);
    const files = await collectFileInputs();
    const src = mergeSource(files);
    const text = await loadSubscription(url, defaultStore(cacheDirectory(), url));
    const runtime = await buildRuntimeConfig({ files, subscriptionYaml: text });
    if (src.selectedNode && !runtime.settings.selectedNode) await writeSelectedNode(null);
    const controller = await resolveController(runtime.overrides.apiPort, runtime.config.apiSecret);
    const hot = await hotReload(controller.apiPort, controller.secret);
    if (hot === 'failed') throw new Error('订阅已保存，但内核刷新失败；请重启内核后生效');
    console.log(hot === 'reloaded' ? '订阅已更新，运行配置已同步' : '订阅已更新（内核未运行，下次启动生效）');
    return;
  }
  if (cmd === 'show') {
    const src = mergeSource(await collectFileInputs());
    const dotenvExists = await Bun.file(DOTENV_PATH()).exists();
    console.log(`bun-clash ${PROGRAM_VERSION} 配置`);
    console.log(`  生效订阅: ${src.subscriptionUrl ?? '（空——直连模式）'}`);
    console.log(
      `  生效来源: ${
        src.source === 'dotenv' ? '.env（dev）' : src.source === 'home' ? '~/.vpn/config.yaml（正式）' : '无（空订阅）'
      }`,
    );
    console.log(`  代理模式: ${src.mode}`);
    if (src.selectedNode) console.log(`  选中节点: ${src.selectedNode}`);
    if (src.httpPort) console.log(`  HTTP 端口: ${src.httpPort}`);
    if (src.socksPort) console.log(`  SOCKS 端口: ${src.socksPort}`);
    if (src.apiPort) console.log(`  API 端口: ${src.apiPort}`);
    console.log(`  配置文件: ${HOME_CONFIG_PATH()}`);
    console.log(`  ${DOTENV_PATH()}: ${dotenvExists ? '存在' : '不存在'}`);
    return;
  }
  usage();
  process.exit(cmd ? 1 : 0);
}
