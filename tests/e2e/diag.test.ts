import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

test('DIAG: kernel child stdout/stderr captured verbatim', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag-'));
  try {
    const child = Bun.spawn([process.execPath, CLI, 'start', '--no-system-proxy',
      '--direct', '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const deadline = Date.now() + 8000;
    const controllerPath = join(home, '.vpn', 'controller.json');
    let ready = false;
    while (Date.now() < deadline) {
      if (existsSync(controllerPath)) { ready = true; break; }
      if (child.exitCode !== null) break;
      await Bun.sleep(50);
    }
    console.log('=== DIAG platform:', process.platform, 'ready:', ready, 'exitCode:', child.exitCode);
    if (!ready) {
      const err = await new Response(child.stderr).text();
      const out = await new Response(child.stdout).text();
      console.log('=== DIAG stdout:', JSON.stringify(out.slice(0, 2000)));
      console.log('=== DIAG stderr:', JSON.stringify(err.slice(0, 2000)));
    } else {
      const controller = JSON.parse(readFileSync(controllerPath, 'utf8')) as { pid: number };
      console.log('=== DIAG controller pid match:', controller.pid === child.pid);
    }
    child.kill();
    await child.exited;
    expect(true).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
