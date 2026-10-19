import { expect, test } from 'bun:test';
import { startListener } from '../../src/core/listener.ts';

test('listen diagnostics preserve permission errors and original cause without claiming a port conflict', async () => {
  const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const error = await startListener('HTTP', 80, async () => { throw cause; }).then(() => null, (e) => e as Error);
  expect(error!.cause).toBe(cause);
  expect(error!.message).toContain('HTTP 监听失败：127.0.0.1:80');
  expect(error!.message).toContain('EACCES');
  expect(error!.message).not.toContain('端口已被占用');
});

test('unknown listener errors retain diagnostic text', async () => {
  await expect(startListener('API', 9090, async () => { throw 'injected'; })).rejects.toThrow('UNKNOWN：injected');
});
