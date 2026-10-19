import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSelfSignedCert } from '../../src/outbound/anytls/testing/mkcert.ts';

const cli = resolve(import.meta.dir, '../../src/cli.ts');

function subscription(names: string[]): string {
  return `proxies:
${names.map((name) => `  - {name: ${name}, type: anytls, server: example.test, port: 443, password: pw}`).join('\n')}
proxy-groups:
  - {name: 🚀 节点选择, type: select, proxies: [${names.join(', ')}]}
rules:
  - MATCH,🚀 节点选择
`;
}

function reservePorts(): number[] {
  const listeners = Array.from({ length: 3 }, () => Bun.listen({
    hostname: '127.0.0.1', port: 0, socket: { data() {} },
  }));
  const ports = listeners.map((s) => s.port);
  for (const listener of listeners) listener.stop(true);
  return ports;
}

test('CLI subscription update synchronizes .env, stored selection and a running kernel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vpn-refresh-e2e-'));
  const cert = await generateSelfSignedCert();
  let yaml = subscription(['旧节点']);
  let broken = false;
  let onFetch: (() => void) | undefined;
  const provider = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch: () => {
      onFetch?.();
      return broken ? new Response('unavailable', { status: 503 }) : new Response(yaml);
    },
  });
  const url = `https://127.0.0.1:${provider.port}/sub`;
  const [httpPort, socksPort, apiPort] = reservePorts();
  const changedApiPort = reservePorts()[2];
  yaml += `external-controller: '127.0.0.1:${apiPort}'\nsecret: 'e2e-secret'\n`;
  const env = { ...process.env, HOME: root, USERPROFILE: root, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  const homePath = join(root, '.vpn/config.yaml');
  const envPath = join(root, '.env');
  await Bun.write(envPath, `SUBSCRIPTION_URL=${url}\nPORT=${httpPort}\nSOCKS_PORT=${socksPort}\n`);
  await Bun.write(homePath, `subscription-url: '${url}'\nselected-node: '旧节点'\n`, {
    createPath: true,
  });
  const kernel = Bun.spawn([process.execPath, cli, 'start', '--no-system-proxy'], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const base = `http://127.0.0.1:${apiPort}`;
  const headers = { authorization: 'Bearer e2e-secret' };
  const proxies = async () => (await (await fetch(`${base}/proxies`, { headers })).json()) as {
    proxies: Record<string, { now?: string }>;
  };
  const command = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, text: stdout + stderr };
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        ready = (await fetch(`${base}/version`, { headers, signal: AbortSignal.timeout(100) })).ok;
      } catch (_e) { /* startup */ }
      if (ready || kernel.exitCode !== null) break;
      await Bun.sleep(20);
    }
    expect(ready).toBe(true);
    expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('旧节点');

    yaml = subscription(['新默认', '新节点']) +
      `external-controller: '127.0.0.1:${changedApiPort}'\nsecret: 'changed-secret'\n`;
    expect((await fetch(`${base}/configs/reload`, { method: 'POST', headers })).status).toBe(204);
    expect((await proxies()).proxies['旧节点']).toBeUndefined();
    expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('新默认');
    // 订阅改变 API 端口/secret 后，CLI 仍须找到原监听器并使用原 secret。
    expect(await Bun.file(homePath).text()).not.toContain('selected-node:');

    const pick = await command('nodes', '--node', '新节点');
    expect(pick.code).toBe(0);
    expect(pick.text).toContain('订阅已刷新');
    expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('新节点');
    expect(await Bun.file(homePath).text()).toContain("selected-node: '新节点'");

    const oldKernel = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: (req) => new URL(req.url).pathname === '/version'
        ? Response.json({ version: 'old' }) : new Response('', { status: 404 }),
    });
    try {
      const incompatible = await command('nodes', '--node', '新节点', '--api-port', String(oldKernel.port));
      expect(incompatible.code).toBe(1);
      expect(incompatible.text).toContain('热切换失败');
      expect(incompatible.text).not.toContain('热切换生效');
    } finally {
      oldKernel.stop(true);
    }

    const savedHome = await Bun.file(homePath).text();
    await Bun.write(homePath, savedHome.replace(/^selected-node:.*$/m, "selected-node: '失效节点'"));
    yaml = subscription(['不应发布']);
    onFetch = () => {
      onFetch = undefined;
      rmSync(homePath);
      mkdirSync(homePath);
    };
    try {
      const denied = await fetch(`${base}/configs/reload`, { method: 'POST', headers });
      expect(denied.status).toBe(400);
      expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('新节点');
      expect((await proxies()).proxies['不应发布']).toBeUndefined();
    } finally {
      rmSync(homePath, { recursive: true, force: true });
      await Bun.write(homePath, savedHome);
    }

    yaml = subscription(['另一订阅']);
    const newUrl = `${url}-new`;
    const update = await command('config', 'set-subscription', newUrl);
    expect(update.code).toBe(0);
    expect(update.text).toContain('运行配置已同步');
    expect(await Bun.file(envPath).text()).toContain(`SUBSCRIPTION_URL=${newUrl}`);
    expect(await Bun.file(homePath).text()).not.toContain('selected-node:');
    expect((await proxies()).proxies['新节点']).toBeUndefined();
    expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('另一订阅');

    broken = true;
    const failed = await command('config', 'set-subscription', `${url}-uncached`);
    expect(failed.code).toBe(1);
    expect(failed.text).not.toContain('运行配置已同步');
    expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('另一订阅');
    expect((await fetch(`${base}/configs/reload`, { method: 'POST', headers })).status).toBe(400);
    expect((await proxies()).proxies['🚀 节点选择']?.now).toBe('另一订阅');
  } finally {
    kernel.kill();
    await kernel.exited;
    provider.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 20000 });
