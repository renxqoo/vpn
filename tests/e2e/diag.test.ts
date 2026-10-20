import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

async function probe(label: string, cmd: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag2-'));
  try {
    const child = Bun.spawn([process.execPath, ...cmd], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 4000);
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D2 ${label}: exit=${JSON.stringify(code)} out=${head(out, 150)} err=${head(err, 300)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('DIAG2: spawn shapes on this platform', async () => {
  console.log('=== D2 platform:', process.platform, 'execPath:', process.execPath);
  await probe('cli-help', [CLI, 'help']);
  await probe('cli-badcmd', [CLI, 'definitely-not-a-command']);
  await probe('e-string', ['-e', 'console.log("E_WORKS")']);
  expect(true).toBe(true);
}, 30_000);
