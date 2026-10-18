/** config 子命令（从原 main.ts 拆出；design.md §1.1 第三批）。 */

import {
  DOTENV_PATH,
  HOME_CONFIG_PATH,
  extractSubscriptionUrl,
  resolveConfigSource,
  setSubscription,
} from './config/paths.ts';
import { PROGRAM_VERSION } from './core/version.ts';

function usage(): void {
  console.log(`用法：bun-clash config set-subscription <URL> | show`);
}

export async function runConfigCommand(sub: string[]): Promise<void> {
  const cmd = sub[0];
  if (cmd === 'set-subscription') {
    const url = sub[1];
    if (!url || !/^https?:\/\//.test(url)) {
      console.error('用法: bun-clash config set-subscription <https://...>');
      process.exit(1);
    }
    const path = await setSubscription(url);
    console.log(`订阅地址已写入 ${path}`);
    return;
  }
  if (cmd === 'show') {
    const src = await resolveConfigSource();
    const homeText = await Bun.file(HOME_CONFIG_PATH()).text();
    const home = extractSubscriptionUrl(homeText);
    const modeMatch = /^mode:\s*(\w+)/m.exec(homeText);
    const dotenvExists = await Bun.file(DOTENV_PATH()).exists();
    console.log(`bun-clash ${PROGRAM_VERSION} 配置`);
    console.log(`  生效订阅: ${src.subscriptionUrl ?? '（空——直连模式）'}`);
    console.log(
      `  生效来源: ${
        src.source === 'dotenv' ? '.env（dev）' : src.source === 'home' ? '~/.vpn/config.yaml（正式）' : '无（空订阅）'
      }`,
    );
    console.log(`  代理模式: ${modeMatch?.[1] ?? 'rule'}`);
    if (src.httpPort) console.log(`  HTTP 端口(.env覆盖): ${src.httpPort}`);
    if (src.socksPort) console.log(`  SOCKS 端口(.env覆盖): ${src.socksPort}`);
    if (src.apiPort) console.log(`  API 端口(.env覆盖): ${src.apiPort}`);
    console.log(`  ${HOME_CONFIG_PATH()} 订阅: ${home.url ?? '（空）'}`);
    console.log(`  ${DOTENV_PATH()}: ${dotenvExists ? '存在' : '不存在'}`);
    return;
  }
  usage();
  process.exit(cmd ? 1 : 0);
}
