import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

async function runMain(label: string, mainTs: string) {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag10-'));
  const main = join(home, 'main.ts');
  try {
    await Bun.write(main, mainTs);
    const child = Bun.spawn([process.execPath, main, 'start', '--direct'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(4000).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D10 ${label}: exit=${JSON.stringify(code)} out=${head(out, 150)} err=${head(err, 250)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('DIAG10: per-import bisection of cli.ts import graph', async () => {
  const mk = (imports: string, body: string) => `#!/usr/bin/env bun\n${imports}\n${body}\n`;
  const body = [
    'const first = process.argv[2];',
    'console.log("DISPATCH", first);',
    "if (first === 'start') console.log('WOULD_RUN_START');",
  ].join('\n');
  const iStart = `import { runStart } from ${JSON.stringify(join(ROOT, 'src/start.ts'))};`;
  await runMain('i1-start', mk(iStart, body));
  const iCfg = `import { runConfigCommand } from ${JSON.stringify(join(ROOT, 'src/config-cmd.ts'))};`;
  await runMain('i2-config-cmd', mk(iCfg, body));
  const iDaemon = `import { runDaemonStart } from ${JSON.stringify(join(ROOT, 'src/system/daemon.ts'))};`;
  await runMain('i3-daemon', mk(iDaemon, body));
  const allImports = [
    `import { runStart } from ${JSON.stringify(join(ROOT, 'src/start.ts'))};`,
    `import { runConfigCommand } from ${JSON.stringify(join(ROOT, 'src/config-cmd.ts'))};`,
    `import { runDaemonStart } from ${JSON.stringify(join(ROOT, 'src/system/daemon.ts'))};`,
  ].join('\n');
  await runMain('i-all-three', mk(allImports, body));
  await runMain('i-all-async-main', mk(allImports,
    'async function main() { console.log("ASYNC_MAIN_RAN"); }\nvoid main().catch((e) => console.error(String(e)));'));
  expect(true).toBe(true);
}, 60_000);
