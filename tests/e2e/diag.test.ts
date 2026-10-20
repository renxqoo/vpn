import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

test('DIAG15: byte-identical cli copy in tmp vs repo', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag15-'));
  const copy = join(home, 'cli-copy.ts');
  try {
    await Bun.write(copy, await Bun.file(CLI).text());
    for (const [label, entry] of [['tmp-copy', copy], ['repo-real', CLI]] as const) {
      const child = Bun.spawn([process.execPath, entry, 'start', '--direct', '--no-system-proxy',
        '--port', '0', '--socks-port', '0', '--api-port', '0'], {
        cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      });
      const code = await Promise.race([child.exited, Bun.sleep(4000).then(() => 'ALIVE' as const)]);
      if (code === 'ALIVE') { child.kill(); await child.exited; }
      const out = await new Response(child.stdout).text();
      const err = await new Response(child.stderr).text();
      const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
      console.log(`=== D15 ${label}: exit=${JSON.stringify(code)} out=${head(out, 120)} err=${head(err, 200)}`);
    }
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
