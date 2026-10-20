import { cliSpawnE2eSupported, CLI_SPAWN_SKIP_REASON } from './cli-spawn.ts';
import { expect, test } from 'bun:test';
import { App } from '../../src/app.ts';
import { buildRuntimeConfig } from '../../src/config/settings.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const busy of ['http', 'socks', 'api'] as const) {
  test(`startup releases earlier listeners when the ${busy} port is occupied`, async () => {
    const occupied = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const httpPort = busy === 'http' ? occupied.port : reservation.port;
    reservation.stop(true);
    const runtime = await buildRuntimeConfig({
      files: { homeConfigText: '', dotenvText: null }, subscriptionYaml: null,
    });
    const app = new App({ config: runtime.config, cacheDir: '/tmp/bunclash-start-cleanup', overrides: {
      httpPort, socksPort: busy === 'socks' ? occupied.port : 0, apiPort: busy === 'api' ? occupied.port : 0,
    } });
    try {
      const error = await app.start().then(() => null, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain(`${busy === 'http' ? 'HTTP' : busy === 'socks' ? 'SOCKS5' : 'API'} 监听失败`);
      expect(error!.message).toContain(`127.0.0.1:${occupied.port}`);
      expect(error!.message).toContain('EADDRINUSE');
      expect(error!.message).toContain(busy === 'http' ? '--port' : busy === 'socks' ? '--socks-port' : '--api-port');
      if (busy !== 'http') {
        const probe = Bun.listen({ hostname: '127.0.0.1', port: httpPort, socket: { data() {} } });
        probe.stop(true);
      }
      const original = await Bun.connect({ hostname: '127.0.0.1', port: occupied.port, socket: { data() {} } });
      original.end();
      expect(app.httpPort).toBe(0);
    } finally { await app.stop(); occupied.stop(true); }
  });
}

test.skipIf(!cliSpawnE2eSupported)(
  'CLI reports exact occupied HTTP endpoint even when subscription log level is silent',
  async () => {
  const root = mkdtempSync(join(tmpdir(), 'vpn-bind-error-'));
  const occupied = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const source = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch: () => new Response('log-level: silent\nrules:\n  - MATCH,DIRECT\n') });
  await Bun.write(join(root, '.vpn/config.yaml'),
    `subscription-url: 'http://127.0.0.1:${source.port}/sub'\n`, { createPath: true });
  try {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../src/cli.ts'),
      'start', '--no-system-proxy', '--port', String(occupied.port), '--socks-port', '0', '--api-port', '0'], {
      cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(out + err).toContain(`HTTP 监听失败：127.0.0.1:${occupied.port}`);
    expect(out + err).toContain('EADDRINUSE');
    expect(out + err).toContain('--port');
  } finally { source.stop(true); occupied.stop(true); rmSync(root, { recursive: true, force: true }); }
});
