import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLockedCommand } from '../../src/system/command.ts';
import { runNetworksetup } from '../../src/system/proxy.ts';
import { testSystemLock } from '../helpers/system-proxy-fake.ts';

test('command output, errors and timeout retain the native lock until release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vpn-command-'));
  const path = join(root, 'operation.lock');
  const lease = await testSystemLock(path);
  const run = (code: string, timeout?: number) =>
    runLockedCommand([process.execPath, '-e', code], lease.fd, timeout);
  try {
    expect(await run("process.stdout.write('done')")).toBe('done');
    if (process.platform === 'darwin') {
      // 只读查询验证真实适配器与锁描述符接缝，不执行任何宿主 setter。
      expect(await runNetworksetup(['-listallnetworkservices'], lease.fd)).toContain('network service');
    }
    await expect(run("process.stderr.write('injected'); process.exit(7)")).rejects.toThrow('injected');
    await expect(run('await Bun.sleep(5000)', 50)).rejects.toThrow('failed');
    await expect(testSystemLock(path)).rejects.toThrow('busy');
    expect(await run("process.stdout.write('still held')")).toBe('still held');
  } finally { await lease.release(); }
  const next = await testSystemLock(path);
  await next.release();
  rmSync(root, { recursive: true, force: true });
});

test('unguarded command timeout terminates a stalled child', async () => {
  await expect(runLockedCommand([process.execPath, '-e', 'await Bun.sleep(5000)'], undefined, 30))
    .rejects.toThrow('failed');
});
