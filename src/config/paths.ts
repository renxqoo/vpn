/**
 * 配置文件定位与读写（合并语义在 settings.ts 的 mergeSource）：
 * 1. dev：cwd/.env（SUBSCRIPTION_URL / PORT / SOCKS_PORT / API_PORT）
 * 2. 正式：~/.vpn/config.yaml（首次启动自动生成空订阅版）
 */

import { logger } from '../core/log.ts';
import { DEFAULT_CONFIG_YAML } from './defaults.ts';

const log = logger('config:paths');

function writePrivate(path: string, data: string): Promise<void> {
  return Bun.write(path, data, { createPath: true }).then(() => {
    try {
      chmodSync(path, 0o600);
    } catch (_e) {
      /* 平台不支持时保持默认 */
    }
  });
}

function privateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (_e) {
    /* noop */
  }
}

import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 家目录：env 优先（Windows USERPROFILE / Unix HOME），os.homedir 兜底 */
export const homeDir = (): string => process.env.USERPROFILE ?? process.env.HOME ?? homedir();

export const HOME_CONFIG_DIR = (): string => join(homeDir(), '.vpn');
/** 订阅快照 / 规则集 / mmdb 的缓存目录（随家目录，不污染启动 cwd） */
export const cacheDirectory = (): string => join(HOME_CONFIG_DIR(), 'cache');
export const HOME_CONFIG_PATH = (): string => join(HOME_CONFIG_DIR(), 'config.yaml');
export const DOTENV_PATH = (): string => join(process.cwd(), '.env');

export interface EnvOverrides {
  subscriptionUrl?: string;
  httpPort?: number;
  socksPort?: number;
  apiPort?: number;
}

/** 极简 .env 解析（KEY=VALUE 每行，# 注释；零依赖） */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function readEnvOverrides(): Promise<EnvOverrides | null> {
  const path = DOTENV_PATH();
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const kv = parseDotEnv(await f.text());
  const num = (v: string | undefined): number | undefined => {
    const n = Number(v);
    return v !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    subscriptionUrl: kv['SUBSCRIPTION_URL'] || undefined,
    httpPort: num(kv['PORT']),
    socksPort: num(kv['SOCKS_PORT']),
    apiPort: num(kv['API_PORT']),
  };
}

/** 家目录配置：不存在则生成（空订阅） */
export async function ensureHomeConfig(): Promise<string> {
  privateDir(HOME_CONFIG_DIR());
  const path = HOME_CONFIG_PATH();
  const f = Bun.file(path);
  if (!(await f.exists())) {
    await writePrivate(path, DEFAULT_CONFIG_YAML);
    log.info(`config created at ${path} (empty subscription — run: bun-clash config set-subscription <URL>)`);
  }
  return path;
}

/** 从家目录配置读订阅地址（同 main 旧逻辑：subscription-url 键提取，余下为 Clash YAML） */
export function extractSubscriptionUrl(text: string): { url?: string; yaml: string } {
  const m = /^subscription-url:\s*'?([^'\n]+)'?\s*$/m.exec(text);
  const yaml = text.replace(/^subscription-url:.*$\n?/m, '');
  return { url: m?.[1]?.trim() || undefined, yaml };
}

/** 把订阅地址写入家目录配置（保留其余行） */
export async function setSubscription(url: string): Promise<string> {
  privateDir(HOME_CONFIG_DIR());
  const path = HOME_CONFIG_PATH();
  const f = Bun.file(path);
  let text = DEFAULT_CONFIG_YAML;
  if (await f.exists()) {
    text = await f.text();
  }
  if (/^subscription-url:.*$/m.test(text)) {
    text = text.replace(/^subscription-url:.*$/m, `subscription-url: '${url}'`);
  } else {
    text = `subscription-url: '${url}'\n${text}`;
  }
  await writePrivate(path, text);
  return path;
}
