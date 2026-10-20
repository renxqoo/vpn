import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

test('DIAG12: real cli.ts with cwd on module drive vs tmp drive', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag12-'));
  try {
    const child = Bun.spawn([process.execPath, CLI, 'start', '--direct', '--no-system-proxy',
      '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: resolve(import.meta.dir, '../..'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log('=== D12(repodir-cwd) exit:', JSON.stringify(code), 'out:', head(out, 400), 'err:', head(err, 300));
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
