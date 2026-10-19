import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AnytlsTestServer } from '../../src/outbound/anytls/testing/server.ts';

const cli = resolve(import.meta.dir, '../../src/cli.ts');
const names = ['香港 01', '香港 02 / %', '美国 01'];

test('CLI lists every node with auth and actual port, preserving selection/mode without repeat probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vpn-node-health-'));
  const server = new AnytlsTestServer({ password: 'health' });
  await server.start();
  const yaml = `secret: 'health-secret'
mode: global
proxies:
${names.map((name, i) => `  - ${JSON.stringify({ name, type: 'anytls', server: '127.0.0.1',
    port: i === 2 ? 1 : server.port, password: 'health', 'skip-cert-verify': true })}`).join('\n')}
proxy-groups:
  - {name: 🚀 节点选择, type: select, proxies: ${JSON.stringify(names)}}
rules:
  - MATCH,🚀 节点选择
`;
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(yaml) });
  const home = join(root, '.vpn/config.yaml');
  const config = `subscription-url: 'http://127.0.0.1:${provider.port}/sub'
selected-node: '${names[0]}'
mode: global
api-port: 1234
`;
  await Bun.write(home, config, { createPath: true });
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  const spawn = (...args: string[]) => Bun.spawn([process.execPath, cli, ...args], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
  });
  const command = async (...args: string[]) => {
    const child = spawn(...args);
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, text: out + err };
  };
  const kernel = spawn('start', '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0');
  try {
    const controller = join(root, '.vpn/controller.json');
    const deadline = Date.now() + 5000;
    while (!existsSync(controller) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(controller)).toBe(true);
    const { apiPort } = JSON.parse(readFileSync(controller, 'utf8')) as { apiPort: number };
    const base = `http://127.0.0.1:${apiPort}`;
    const headers = { authorization: 'Bearer health-secret' };
    expect(await (await fetch(`${base}/configs`, { headers })).json()).toEqual({ mode: 'global' });
    const before = await command('nodes', '--list');
    expect(before.code).toBe(0);
    for (const name of names) expect(before.text).toContain(name);
    expect(before.text.match(/未探测/g)?.length).toBe(3);
    expect(server.events.targets).toHaveLength(0);

    const checked = await command('nodes', '--check');
    expect(checked.code).toBe(0);
    for (const name of names) expect(checked.text).toContain(name);
    expect(checked.text).toMatch(/香港 01\s+可用 · \d+ms/);
    expect(checked.text).toMatch(/香港 02 \/ %\s+可用 · \d+ms/);
    expect(checked.text).toMatch(/美国 01\s+不可用\/超时/);
    expect(server.events.targets).toHaveLength(2);
    expect(server.events.targets.every((target) => target === 'cp.cloudflare.com:80')).toBe(true);

    const list = await command('nodes', '--list');
    const status = await command('status');
    expect(list.code).toBe(0);
    expect(status.code).toBe(0);
    expect(status.text).toContain(`内核运行中（前台，PID `);
    expect(status.text).toContain(`API 127.0.0.1:${apiPort}）`);
    for (const name of names) expect(status.text).toContain(name);
    expect(status.text).toContain('不可用/超时');
    expect(status.text).toContain('节点 3 个');
    expect(server.events.targets).toHaveLength(2);

    const select = Bun.spawn([process.execPath, '--preload',
      resolve(import.meta.dir, '../fixtures/node-select-preload.ts'), cli, 'nodes'], {
      cwd: root, env, stdout: 'ignore', stderr: 'pipe',
    });
    expect(await select.exited).toBe(1); // 截获列表后取消，不能写入选择。
    const choices = JSON.parse(readFileSync(join(root, 'node-options.json'), 'utf8')) as {
      value: { group: boolean }; label: string;
    }[];
    const labels = choices.filter((choice) => !choice.value.group).map((choice) => choice.label);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/香港 01\s+可用 · \d+ms/);
    expect(labels[1]).toMatch(/香港 02 \/ %\s+可用 · \d+ms/);
    expect(labels[2]).toContain('不可用/超时');

    expect((await command('nodes', '--check', '--node', names[1]!)).code).toBe(0);
    expect(server.events.targets).toHaveLength(3);
    expect((await command('nodes', '--check', '--node', 'missing')).code).toBe(1);
    expect((await command('nodes', '--list', '--node', names[0]!)).code).toBe(1);
    expect((await command('nodes', '--node')).code).toBe(1);
    expect(server.events.targets).toHaveLength(3);
    expect(await Bun.file(home).text()).toBe(config);
    const proxies = await (await fetch(`${base}/proxies`, { headers })).json() as {
      proxies: Record<string, { now?: string; health?: { samples: number } }>;
    };
    expect(proxies.proxies['🚀 节点选择']?.now).toBe(names[0]);
    expect(proxies.proxies[names[1]!]!.health?.samples).toBe(2);
    expect(await (await fetch(`${base}/configs`, { headers })).json()).toEqual({ mode: 'global' });

    const oldApi = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) =>
      new URL(request.url).pathname === '/proxies' ? Response.json({ proxies: {} }) :
        new Response('', { status: 404 }) });
    try {
      const old = await command('nodes', '--check', '--api-port', String(oldApi.port));
      expect(old.code).toBe(1);
      expect(old.text).toContain('旧内核');
    } finally { oldApi.stop(true); }
    expect((await command('stop')).code).toBe(0);
    expect(await kernel.exited).toBe(0);
    const offline = await command('nodes', '--list');
    expect(offline.code).toBe(0);
    expect(offline.text).toContain('内核未运行');
    expect(offline.text).not.toContain('不可用/超时');
    expect((await command('nodes', '--check')).text).toContain('内核未运行');
  } finally {
    if (kernel.exitCode === null) { kernel.kill('SIGKILL'); await kernel.exited; }
    provider.stop(true);
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 15000 });

test('offline list and selection display prototype-named nodes as unmeasured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vpn-node-names-'));
  const names = ['constructor', 'toString', '__proto__'];
  const yaml = `proxies:\n${names.map((name) => `  - ${JSON.stringify({
    name, type: 'anytls', server: '127.0.0.1', port: 1, password: 'test',
  })}`).join('\n')}\n`;
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(yaml) });
  const offline = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open(socket) { socket.end(); }, data() {} } });
  await Bun.write(join(root, '.vpn/config.yaml'),
    `subscription-url: 'http://127.0.0.1:${provider.port}/sub'\n`, { createPath: true });
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  try {
    const list = Bun.spawn([process.execPath, cli, 'nodes', '--list', '--api-port', String(offline.port)], {
      cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, out] = await Promise.all([list.exited, new Response(list.stdout).text()]);
    expect(code).toBe(0);
    expect(out.match(/未探测/g)?.length).toBe(4); // 三行节点，加离线提示。
    expect(out).not.toContain('不可用/超时');
    const select = Bun.spawn([process.execPath, '--preload',
      resolve(import.meta.dir, '../fixtures/node-select-preload.ts'), cli, 'nodes',
      '--api-port', String(offline.port)], {
      cwd: root, env, stdout: 'ignore', stderr: 'pipe',
    });
    expect(await select.exited).toBe(1);
    const options = JSON.parse(readFileSync(join(root, 'node-options.json'), 'utf8')) as {
      value: { group: boolean }; label: string;
    }[];
    for (const option of options.filter((option) => !option.value.group)) expect(option.label).toContain('未探测');
  } finally { provider.stop(true); offline.stop(true); rmSync(root, { recursive: true, force: true }); }
});
