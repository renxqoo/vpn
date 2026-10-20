import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

async function runMain(label: string, mainTs: string) {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag9-'));
  const main = join(home, 'main.ts');
  try {
    await Bun.write(main, mainTs);
    const child = Bun.spawn([process.execPath, main, 'start', '--direct'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(5000).then(() => 'ALIVE' as const)]);
    if (code === 'ALIVE') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D9 ${label}: exit=${JSON.stringify(code)} out=${head(out, 200)} err=${head(err, 300)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('DIAG9: static vs dynamic import of start chain', async () => {
  const startPath = JSON.stringify(join(ROOT, 'src/start.ts'));
  await runMain('static-import', `import { runStart } from ${startPath};\nconsole.log('M1');\n`);
  const vhelp = [
    '#!/usr/bin/env bun',
    `import { runStart } from ${startPath};`,
    'const first = process.argv[2];',
    "console.log('M2 first=', first);",
    '',
  ].join('\n');
  await runMain('cli-verbatim-help', vhelp);
  expect(true).toBe(true);
}, 30_000);
