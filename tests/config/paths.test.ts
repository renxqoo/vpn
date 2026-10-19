import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDotEnv,
  readEnvOverrides,
  setSubscription,
  extractSubscriptionUrl,
  cacheDirectory,
} from '../../src/config/paths.ts';
import { DEFAULT_CONFIG_YAML } from '../../src/config/defaults.ts';

const realHome = process.env.HOME as string;
const realProfile = process.env.USERPROFILE as string | undefined;
const tmpHome = mkdtempSync(join(tmpdir(), 'vpn-home-'));

beforeAll(() => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  if (realProfile !== undefined) process.env.USERPROFILE = realProfile;
  else delete process.env.USERPROFILE;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('cache directory', () => {
  test('lives under ~/.vpn, not cwd', () => {
    const dir = cacheDirectory();
    expect(dir.startsWith(tmpHome)).toBe(true);
    expect(dir.endsWith('.vpn/cache')).toBe(true);
  });
});

describe('dotenv parse', () => {
  test('key=value with comments and quotes', () => {
    const kv = parseDotEnv('# comment\nA=1\nB="x y"\nC=\'z\'\nBAD\nD=\n');
    expect(kv['A']).toBe('1');
    expect(kv['B']).toBe('x y');
    expect(kv['C']).toBe('z');
    expect(kv['BAD']).toBeUndefined();
    expect(kv['D']).toBe('');
  });
});

describe('home config lifecycle', () => {
  test('set-subscription creates ~/.vpn/config.yaml and writes url', async () => {
    const path = await setSubscription('https://example.com/sub?clash=1');
    expect(path).toBe(join(tmpHome, '.vpn', 'config.yaml'));
    expect(existsSync(path)).toBe(true);
    const { url, yaml } = extractSubscriptionUrl(readFileSync(path, 'utf8'));
    expect(url).toBe('https://example.com/sub?clash=1');
    expect(yaml).not.toContain('subscription-url');
    expect(yaml).toContain('port: 7890');
  });

  test('set-subscription twice replaces, keeps other lines', async () => {
    const path = await setSubscription('https://first.example/x');
    const custom = readFileSync(path, 'utf8') + '# my note\n';
    writeFileSync(path, custom);
    await setSubscription('https://second.example/y');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('https://second.example/y');
    expect(text).not.toContain('first.example');
    expect(text).toContain('# my note');
  });

  test('default template has empty subscription line', () => {
    expect(DEFAULT_CONFIG_YAML).toContain("subscription-url: ''");
    const { url } = extractSubscriptionUrl(DEFAULT_CONFIG_YAML);
    expect(url).toBeUndefined();
  });
});

describe('env overrides', () => {
  test('reads .env values when present', async () => {
    // readEnvOverrides 读 cwd/.env —— 测试进程 cwd 即项目根
    const envPath = `${process.cwd()}/.env`;
    const had = existsSync(envPath);
    const backup = had ? readFileSync(envPath, 'utf8') : null;
    writeFileSync(envPath, 'SUBSCRIPTION_URL=https://dev.example/sub\nPORT=17890\nSOCKS_PORT=17891\n');
    try {
      const env = await readEnvOverrides();
      expect(env?.subscriptionUrl).toBe('https://dev.example/sub');
      expect(env?.httpPort).toBe(17890);
      expect(env?.socksPort).toBe(17891);
      expect(env?.apiPort).toBeUndefined();
    } finally {
      if (had && backup !== null) writeFileSync(envPath, backup);
      else if (!had) rmSync(envPath);
    }
  });
});
