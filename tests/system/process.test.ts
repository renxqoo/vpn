import { expect, test } from 'bun:test';
import { processAlive, processBirth } from '../../src/system/process.ts';

test('process identity detects live, dead and reused PID records', async () => {
  expect(await processAlive(process.pid)).toBe(true);
  expect(await processAlive(2147483647)).toBe(false);
  expect(await processBirth(2147483647)).toBeUndefined();
  const birth = await processBirth(process.pid);
  if (process.platform === 'win32') expect(birth).toBeUndefined();
  else {
    expect(birth).toBeTruthy();
    expect(await processAlive(process.pid, birth)).toBe(true);
    expect(await processAlive(process.pid, 'previous process')).toBe(false);
    const original = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      expect(await processBirth(process.pid)).toBe(birth);
      process.env.TZ = 'Asia/Shanghai';
      expect(await processBirth(process.pid)).toBe(birth);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  }
});
