import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRuntimeConfig,
  mergeSource,
  type FileInputs,
  type RuntimeSettings,
} from '../../src/config/settings.ts';

const realHome = process.env.HOME as string;
const realProfile = process.env.USERPROFILE as string | undefined;
const home = mkdtempSync(join(tmpdir(), 'vpn-settings-'));
const cwd = mkdtempSync(join(tmpdir(), 'vpn-cwd-'));

function inputs(opts: Partial<FileInputs> = {}): FileInputs {
  return {
    homeConfigText: '',
    dotenvText: null,
    ...opts,
  };
}

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterAll(() => {
  process.env.HOME = realHome;
  if (realProfile !== undefined) process.env.USERPROFILE = realProfile;
  else delete process.env.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('mergeSource：两级来源合并', () => {
  test('两级都空 → empty（订阅空，全默认）', () => {
    const m = mergeSource(inputs());
    expect(m.subscriptionUrl).toBeUndefined();
    expect(m.source).toBe('empty');
    expect(m.selectedNode).toBeUndefined();
    expect(m.mode).toBe('rule');
  });

  test('只有家目录有订阅 → home 来源，键齐全解析', () => {
    const m = mergeSource(
      inputs({
        homeConfigText: [
          "subscription-url: 'https://sub.example.net/l/tok?clash=1'",
          "selected-node: '台湾 01'",
          'mode: global',
          'port: 7890',
        ].join('\n'),
      }),
    );
    expect(m.source).toBe('home');
    expect(m.subscriptionUrl).toBe('https://sub.example.net/l/tok?clash=1');
    expect(m.selectedNode).toBe('台湾 01');
    expect(m.mode).toBe('global');
    expect(m.httpPort).toBe(7890);
  });

  test('.env 订阅优先于家目录；端口覆盖生效', () => {
    const m = mergeSource(
      inputs({
        homeConfigText: "subscription-url: 'https://home.example/x'\nmode: direct\nport: 7890",
        dotenvText: 'SUBSCRIPTION_URL=https://dev.example/y\nPORT=17890\nSOCKS_PORT=17891\n',
      }),
    );
    expect(m.subscriptionUrl).toBe('https://dev.example/y');
    expect(m.source).toBe('dotenv');
    expect(m.httpPort).toBe(17890);
    expect(m.socksPort).toBe(17891);
    // mode/selectedNode 仍来自家目录（.env 只管订阅与端口）
    expect(m.mode).toBe('direct');
  });

  test('.env 无订阅键时回退家目录订阅', () => {
    const m = mergeSource(
      inputs({
        homeConfigText: "subscription-url: 'https://home.example/x'",
        dotenvText: 'PORT=17890\n',
      }),
    );
    expect(m.subscriptionUrl).toBe('https://home.example/x');
    expect(m.source).toBe('home');
    expect(m.httpPort).toBe(17890);
  });

  test('坏值被忽略：mode 非法回 rule、端口非数字忽略', () => {
    const m = mergeSource(
      inputs({
        homeConfigText: 'mode: bogus\nport: not-a-number\nsubscription-url: x',
      }),
    );
    expect(m.mode).toBe('rule');
    expect(m.httpPort).toBeUndefined();
  });

  test('selected-node 的引号转义读回', () => {
    const m = mergeSource(inputs({ homeConfigText: "selected-node: 'a''b'" }));
    expect(m.selectedNode).toBe("a'b");
  });
});

describe('buildRuntimeConfig：合并 + CLI 覆盖 → 启动配置', () => {
  const subYaml = [
    'port: 7890',
    'socks-port: 7891',
    'mode: rule',
    'proxies:',
    '  - {name: 台湾 01, type: anytls, server: s.example.net, port: 1, password: p}',
    'proxy-groups:',
    '-',
    '  name: 🚀 节点选择',
    '  type: select',
    '  proxies:',
    '    - DIRECT',
    'rules:',
    '  - MATCH,DIRECT',
  ].join('\n');

  test('订阅 YAML 解析 + selected-node 注入 select 组 + 端口覆盖优先级（CLI > .env > 订阅）', async () => {
    const cfg = await buildRuntimeConfig({
      files: {
        homeConfigText: "subscription-url: 'https://s.example/x'\nselected-node: 台湾 01",
        dotenvText: 'PORT=17890\n',
      },
      subscriptionYaml: subYaml,
      cli: { port: 17899 },
    });
    expect(cfg.config.proxies.length).toBe(1);
    expect(cfg.config.httpPort).toBe(17899);
    expect(cfg.settings.selectedNode).toBe('台湾 01');
    expect(cfg.sourceLabel).toContain('.env');
  });

  test('无订阅 → 直连兜底配置 + 引导标记', async () => {
    const cfg = await buildRuntimeConfig({ files: inputs(), subscriptionYaml: null });
    expect(cfg.config.proxies).toHaveLength(0);
    expect(cfg.config.rules[cfg.config.rules.length - 1]?.target).toBe('DIRECT');
    expect(cfg.settings.subscriptionUrl).toBeUndefined();
    expect(cfg.needsSubscriptionGuide).toBe(true);
  });

  test('订阅缺失 selected-node 时不注入（组内无该成员）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({
        homeConfigText: "subscription-url: 'https://s.example/x'\nselected-node: 不存在的节点",
      }),
      subscriptionYaml: subYaml,
    });
    expect(cfg.settings.selectedNode).toBe('不存在的节点');
    expect(cfg.warnings.some((w) => w.includes('不存在的节点'))).toBe(true);
  });
});

void mkdirSync;
void writeFileSync;
void readFileSync;
void cwd;
