import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('DIAG6: does Bun.file(nonexistent).json() settle on this platform', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag6-'));
  const script = join(home, 'p.ts');
  try {
    await Bun.write(script, `
console.log('P0');
const f = Bun.file(${JSON.stringify(join(home, 'no-such.json'))});
const t = setTimeout(() => { console.log('P_TIMEOUT_JSON_NEVER_SETTLES'); process.exit(42); }, 4000);
try {
  await f.json();
  console.log('P_RESOLVED');
} catch (e) {
  console.log('P_REJECTED', String(e).slice(0, 120));
}
clearTimeout(t);
const fe = await Bun.file(${JSON.stringify(join(home, 'no-such.json'))}).exists();
console.log('P_EXISTS', fe);
console.log('P_DONE');
`);
    const child = Bun.spawn([process.execPath, script], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(8000).then(() => 'HANG' as const)]);
    const out = await new Response(child.stdout).text();
    console.log('=== D6 exit:', JSON.stringify(code), 'out:', JSON.stringify(out.slice(0, 400)));
    if (code === 'HANG') child.kill();
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20_000);
