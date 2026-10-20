import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');

function tree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      out.push(prefix + name);
      try {
        if (readdirSync(p).length >= 0 && existsSync(join(p, '.')) && name !== '.git') {
          out.push(...tree(p, `${prefix}${name}/`));
        }
      } catch (_e) { /* not a dir */ }
    }
  } catch (_e) { /* gone */ }
  return out;
}

test('DIAG4: what does cli start leave behind before exiting', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag4-'));
  try {
    const child = Bun.spawn([process.execPath, CLI, 'start', '--direct', '--no-system-proxy',
      '--port', '0', '--socks-port', '0', '--api-port', '0'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(6000).then(() => 'ALIVE' as const)]);
    console.log('=== D4 platform:', process.platform, 'exit:', JSON.stringify(code));
    console.log('=== D4 home tree:', JSON.stringify(tree(home)));
    const cfgPath = join(home, '.vpn/config.yaml');
    if (existsSync(cfgPath)) console.log('=== D4 config.yaml:', JSON.stringify(readFileSync(cfgPath, 'utf8')));
    if (typeof code === 'number') {
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      console.log('=== D4 out:', JSON.stringify(out.slice(0, 400)));
      console.log('=== D4 err:', JSON.stringify(err.slice(0, 600)));
    } else child.kill();
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
