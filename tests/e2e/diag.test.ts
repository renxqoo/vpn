import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('DIAG7: bisect runStart body by stage markers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vpn-diag7-'));
  const script = join(home, 'p.ts');
  try {
    const VPN_SRC = resolve(import.meta.dir, '../../src/config');
    const CACHE_LITERAL = JSON.stringify(join(home, '.vpn/cache'));
    await Bun.write(script, `
console.log('S0');
const { readRunningController } = await import(process.env.VPN_SRC + '/controller.ts');
console.log('S1 imported');
const r = await readRunningController();
console.log('S2 controller read:', JSON.stringify(r));
const { collectFileInputs } = await import(process.env.VPN_SRC + '/settings.ts');
console.log('S3 settings imported');
const files = await collectFileInputs();
console.log('S4 inputs collected');
const { App } = await import(process.env.VPN_SRC + '/../app.ts');
console.log('S5 app imported');
const { buildRuntimeConfig } = await import(process.env.VPN_SRC + '/settings.ts');
const rt = await buildRuntimeConfig({ files, subscriptionYaml: null, cli: { direct: true } });
console.log('S6 runtime built');
const app = new App({ config: rt.config, cacheDir: ${CACHE_LITERAL}, overrides: rt.overrides });
await app.start();
console.log('S7 app started http=%d api=%d', app.httpPort, app.apiPortForTest);
setTimeout(() => { console.log('S8 still alive after 1s'); process.exit(0); }, 1000);
`);
    const child = Bun.spawn([process.execPath, script], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, VPN_SRC: VPN_SRC },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const code = await Promise.race([child.exited, Bun.sleep(10000).then(() => 'HANG' as const)]);
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    const lastMarker = out.split('\n').filter((l) => /^S\d/.test(l)).pop() ?? '(none)';
    console.log('=== D7 exit:', JSON.stringify(code), 'last marker:', lastMarker);
    console.log('=== D7 out:', JSON.stringify(out.slice(0, 700)));
    console.log('=== D7 err:', JSON.stringify(err.slice(0, 500)));
    if (code === 'HANG') child.kill();
    expect(true).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);
