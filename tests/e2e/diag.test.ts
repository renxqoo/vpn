import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('DIAG11: Bun.file on missing path in spawn child (8.3-shortname probe)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag11-'));
  const script = join(home, 'p.ts');
  try {
    const target = join(home, 'missing.json');
    const targetLiteral = JSON.stringify(target);
    await Bun.write(script, `
console.log('Q0 home =', ${targetLiteral.slice(0, 20)} + '...');
console.log('Q1 existsSync =', require('node:fs').existsSync(${targetLiteral}));
const f = Bun.file(${targetLiteral});
console.log('Q2 Bun.file constructed');
const t = setTimeout(() => { console.log('Q_TIMEOUT_BUN_FILE_NEVER_SETTLES'); process.exit(9); }, 3500);
try { await f.json(); console.log('Q3 resolved'); } catch (e) { console.log('Q3 rejected', String(e).slice(0, 100)); }
clearTimeout(t);
console.log('Q4 exists =', await f.exists());
`);
    const child = Bun.spawn([process.execPath, script], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'HANG' as const)]);
    if (code === 'HANG') { child.kill(); await child.exited; }
    const out = await new Response(child.stdout).text();
    console.log('=== D11 exit:', JSON.stringify(code));
    console.log('=== D11 out:', JSON.stringify(out.slice(0, 500)));
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20_000);
