import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

const TRACE = `
console.log('T> preload loaded');
process.on('exit', (c) => console.log('T> exit event code=', c));
process.on('uncaughtException', (e) => console.log('T> uncaught', String(e).slice(0, 200)));
process.on('unhandledRejection', (e) => console.log('T> unhandledRejection', String(e).slice(0, 200)));
`;

test('DIAG5: trace cli start via preload', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag5-'));
  const preload = join(home, 'trace.ts');
  try {
    await Bun.write(preload, TRACE);
    const child = Bun.spawn([process.execPath, '--preload', preload, CLI, 'start', '--direct',
      '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(6000).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') {
      child.kill();
      await child.exited;
    }
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log('=== D5 exit:', JSON.stringify(code));
    console.log('=== D5 out:', head(out, 900));
    console.log('=== D5 err:', head(err, 900));
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
