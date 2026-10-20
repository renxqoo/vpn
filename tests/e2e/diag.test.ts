import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

test('DIAG18: node:child_process spawn of cli start', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag18-'));
  try {
    const child = nodeSpawn(process.execPath, [CLI, 'start', '--direct', '--no-system-proxy',
      '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout!.on('data', (d) => { out += d; });
    child.stderr!.on('data', (d) => { err += d; });
    const code = await new Promise<number | 'ALIVE'>((resolveCode) => {
      const timer = setTimeout(() => resolveCode('ALIVE'), 4500);
      child.on('exit', (c) => { clearTimeout(timer); resolveCode(c ?? -1); });
    });
    if (code === 'ALIVE') child.kill();
    await new Promise((r) => setTimeout(r, 200));
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D18 node-spawn: exit=${JSON.stringify(code)} out=${head(out, 100)} err=${head(err, 150)}`);
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
