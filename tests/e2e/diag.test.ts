import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

test('DIAG8: main-dispatch trace via preload argv observation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag8-'));
  const preload = join(home, 'trace.ts');
  try {
    await Bun.write(preload, `
console.log('T0 preload');
process.on('exit', (c) => console.log('T_EXIT', c));
console.log('T1 argv', JSON.stringify(process.argv.slice(2)));
setTimeout(() => console.log('T2 tick1s'), 1000).unref?.();
`);
    const child = Bun.spawn([process.execPath, '--preload', preload, CLI, 'start', '--direct',
      '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(6000).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log('=== D8 exit:', JSON.stringify(code), 'out:', head(out, 500), 'err:', head(err, 500));
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
