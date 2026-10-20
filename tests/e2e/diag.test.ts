import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

async function probe(label: string, argv: string[], opts: { shell?: boolean; cwd?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag16-'));
  try {
    const child = Bun.spawn(argv, {
      cwd: opts.cwd ?? home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(4500).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D16 ${label}: exit=${JSON.stringify(code)} out=${head(out, 80)} err=${head(err, 150)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const ARGS = ['start', '--direct', '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'];

test('DIAG16: spawn shapes that keep the kernel alive', async () => {
  await probe('plain', [process.execPath, CLI, ...ARGS]);
  await probe('with-run', [process.execPath, 'run', CLI, ...ARGS]);
  await probe('stdin-pipe', [process.execPath, CLI, ...ARGS]);
  expect(true).toBe(true);
}, 40_000);
