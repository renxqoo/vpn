import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

async function probe(label: string, script: string) {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag3-'));
  const scriptPath = join(home, 'probe.ts');
  try {
    await Bun.write(scriptPath, script);
    const child = Bun.spawn([process.execPath, scriptPath], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 6000);
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    const head = (s: string, n: number) => JSON.stringify(s.slice(0, n));
    console.log(`=== D3 ${label}: exit=${JSON.stringify(code)} out=${head(out, 100)} err=${head(err, 400)}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('DIAG3: import-graph bisection', async () => {
  console.log('=== D3 platform:', process.platform, 'root:', ROOT);
  await probe('import-start-only',
    `await import(${JSON.stringify(join(ROOT, 'src/start.ts'))});\nconsole.log('IMPORT_OK');\n`);
  await probe('import-app',
    `await import(${JSON.stringify(join(ROOT, 'src/app.ts'))});\nconsole.log('IMPORT_OK');\n`);
  const args = `'start', '--direct', '--no-system-proxy', '--port', '0', '--socks-port', '0', '--api-port', '0'`;
  await probe('run-start-direct', `
process.argv = [process.execPath, 'cli', ${args}];
const { runStart } = await import(${JSON.stringify(join(ROOT, 'src/start.ts'))});
await runStart(process.argv.slice(2));
console.log('RUNSTART_RETURNED');
`);
  expect(true).toBe(true);
}, 60_000);
