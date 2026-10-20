import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const E2E = import.meta.dir;
const ROOT = resolve(E2E, '../..');

test('DIAG13: relative-import clone of cli.ts living in repo tree', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag13-'));
  const cloneDir = join(E2E, 'diag-clone');
  const clone = join(cloneDir, 'cli-clone.ts');
  try {
    const source = await Bun.file(join(ROOT, 'src/cli.ts')).text();
    await Bun.write(clone, source.replace("from './start.ts'", "from '../../../src/start.ts'")
      .replace("from './config-cmd.ts'", "from '../../../src/config-cmd.ts'")
      .replace("from './system/daemon.ts'", "from '../../../src/system/daemon.ts'"));
    const child = Bun.spawn([process.execPath, clone, 'start', '--direct', '--no-system-proxy',
      '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log('=== D13(clone-in-repo) exit:', JSON.stringify(code), 'out:', head(out, 300), 'err:', head(err, 300));
    expect(true).toBe(true);
  } finally {
    rmSync(cloneDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
