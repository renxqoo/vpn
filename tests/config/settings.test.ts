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
    '    - 台湾 01',
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
    expect(cfg.config.groups[0]?.proxies[0]).toBe('台湾 01');
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
    // 失效选择不能继续作为生效配置展示（旧行为会显示已删除节点）。
    expect(cfg.settings.selectedNode).toBeUndefined();
    expect(cfg.warnings.some((w) => w.includes('不存在的节点'))).toBe(true);
  });

  test('家目录 mode 覆盖订阅 mode（本地运行态只听本地配置）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'\nmode: global" }),
      subscriptionYaml: subYaml,
    });
    expect(cfg.config.mode).toBe('global');
  });

  test('订阅 log-level: silent 不吞掉内核反馈（未在本地配置时不生效）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'" }),
      subscriptionYaml: `${subYaml}\nlog-level: silent\n`,
    });
    expect(cfg.config.logLevel).toBe('info');
  });

  test('家目录 log-level 控制内核日志级别', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'\nlog-level: warn" }),
      subscriptionYaml: `${subYaml}\nlog-level: debug\n`,
    });
    expect(cfg.config.logLevel).toBe('warn');
  });

  test('家目录 log-level 带引号照常生效（模板把值写成引号形式）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'\nlog-level: 'silent'" }),
      subscriptionYaml: subYaml,
    });
    expect(cfg.config.logLevel).toBe('silent');
  });

  test('家目录 mode 带引号照常生效（与 log-level 引号语义一致）', () => {
    const m = mergeSource(inputs({ homeConfigText: "mode: 'global'" }));
    expect(m.mode).toBe('global');
  });

  test('--direct 是显式 CLI 运行态，压过家目录 mode（展示与路由一致）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'\nmode: global" }),
      subscriptionYaml: null,
      cli: { direct: true },
    });
    expect(cfg.config.mode).toBe('direct');
  });

  test('订阅非法 mode 不阻断启动（运行时 mode 只来自本地）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'" }),
      subscriptionYaml: subYaml.replace('mode: rule', 'mode: bogus'),
    });
    expect(cfg.config.mode).toBe('rule');
  });

  test('本地 secret 显式空串 = 本机免鉴权选择，不回退订阅 secret', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'\nsecret: ''" }),
      subscriptionYaml: `${subYaml}\nsecret: 'attacker-known-token'\n`,
    });
    expect(cfg.config.apiSecret).toBe('');
  });

  test('本地 secret 非空时本地赢（既有行为不变）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'\nsecret: 'local-token'" }),
      subscriptionYaml: `${subYaml}\nsecret: 'attacker-known-token'\n`,
    });
    expect(cfg.config.apiSecret).toBe('local-token');
  });

  test('本地未写 secret 键时不引入订阅 secret（API 保持本机免鉴权）', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'" }),
      subscriptionYaml: `${subYaml}\nsecret: 'attacker-known-token'\n`,
    });
    expect(cfg.config.apiSecret).toBe('');
  });

  test('本地 external-controller 端口生效，订阅值不决定 API 监听端口', async () => {
    const home = "subscription-url: 'https://s.example/x'\nexternal-controller: '127.0.0.1:9999'";
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: home }),
      subscriptionYaml: `${subYaml}\nexternal-controller: '127.0.0.1:12345'\n`,
    });
    expect(cfg.overrides.apiPort).toBe(9999);
  });

  test('本地未写 external-controller 时 API 端口缺省 9090，不取订阅值', async () => {
    const cfg = await buildRuntimeConfig({
      files: inputs({ homeConfigText: "subscription-url: 'https://s.example/x'" }),
      subscriptionYaml: `${subYaml}\nexternal-controller: '127.0.0.1:12345'\n`,
    });
    expect(cfg.overrides.apiPort).toBe(9090);
  });
});

void mkdirSync;
void writeFileSync;
void readFileSync;
void cwd;

test('subscription changes cannot retain an unsupported node as the effective selection', async () => {
  const runtime = await buildRuntimeConfig({
    files: inputs({ homeConfigText: "subscription-url: 'https://s.test/sub'\nselected-node: '旧节点'\n" }),
    subscriptionYaml: `proxies:
  - {name: 旧节点, type: vmess}
  - {name: 新节点, type: anytls, server: new.test, port: 443, password: pw}
proxy-groups:
  - {name: 🚀 节点选择, type: select, proxies: [旧节点, 新节点]}
rules:
  - MATCH,🚀 节点选择
`,
  });
  expect(runtime.settings.selectedNode).toBeUndefined();
  expect(runtime.warnings.length).toBe(1);
});

test('effective subscription URL decodes escaped quotes written by set-subscription', () => {
  expect(mergeSource(inputs({
    homeConfigText: "subscription-url: 'https://example.test/sub?token=a''b$&'\n",
  })).subscriptionUrl).toBe("https://example.test/sub?token=a'b$&");
});
