import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

async function probe(label: string, env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag17-'));
  try {
    const child = Bun.spawn([process.execPath, CLI, 'start', '--direct', '--no-system-proxy',
      '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(4500).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D17 ${label}: exit=${JSON.stringify(code)} out=${head(out, 80)} err=${head(err, 150)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const ARGS_HOME = (home: string) => ({ HOME: home, USERPROFILE: home });

test('DIAG17: env sanitization probe', async () => {
  const full = process.env as Record<string, string>;
  await probe('full-env', full);
  const minimal: Record<string, string> = {
    PATH: full.PATH ?? '', SYSTEMROOT: full.SYSTEMROOT ?? full.SystemRoot ?? '',
    TEMP: full.TEMP ?? '', TMP: full.TMP ?? '',
    ...(process.platform === 'win32' ? {} : ARGS_HOME('')),
  };
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag17h-'));
  minimal.HOME = home;
  minimal.USERPROFILE = home;
  await probe('minimal-env', minimal);
  const suspicious = Object.keys(full).filter((k) => /^BUN_|^GITHUB|^RUNNER|^NODE|^CI/i.test(k));
  console.log('=== D17 suspicious keys:', JSON.stringify(suspicious));
  expect(true).toBe(true);
}, 40_000);
