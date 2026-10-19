/** 仅由子进程测试显式 --preload 引入，替代系统网络命令。 */
import { mock } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SystemProxyManager } from '../../src/system/proxy.ts';
import { runLockedCommand } from '../../src/system/command.ts';
import { FakeNetwork, testSystemLock } from '../helpers/system-proxy-fake.ts';

const root = process.env.USERPROFILE ?? process.env.HOME!;
const statePath = join(root, 'fake-network.json');
const callsPath = join(root, 'fake-network-calls.json');
const network = new FakeNetwork();
if (existsSync(statePath)) network.services = JSON.parse(readFileSync(statePath, 'utf8')) as typeof network.services;
const persist = () => writeFileSync(statePath, JSON.stringify(network.services));
network.changed = persist;
network.fail = (args) => {
  if (existsSync(join(root, 'fake-fail-restore')) &&
    args[0] === '-setwebproxy' && args[2] !== '127.0.0.1') return true;
  const once = join(root, 'fake-fail-once');
  if (existsSync(once) && readFileSync(once, 'utf8').trim() === args[0]) { rmSync(once); return true; }
  return false;
};
persist();
mock.module('../../src/system/proxy.ts', () => ({
  SystemProxyManager,
  createSystemProxyManager: () => new SystemProxyManager({
    platform: 'darwin',
    acquire: testSystemLock,
    run: async (args: string[], fd?: number) => {
      if (existsSync(join(root, 'fake-delayed-native')) && args[0] === '-setwebproxy') {
        await runLockedCommand([process.execPath, join(import.meta.dir, 'system-proxy-native.ts'),
          root, JSON.stringify(args)], fd);
        network.services = JSON.parse(readFileSync(statePath, 'utf8')) as typeof network.services;
        return '';
      }
      const result = await network.run(args);
      writeFileSync(callsPath, JSON.stringify(network.calls));
      const pause = join(root, 'fake-pause-after');
      if (existsSync(pause) && readFileSync(pause, 'utf8').trim() === args[0]) {
        writeFileSync(join(root, 'fake-paused'), '1');
        await new Promise<void>(() => {});
      }
      return result;
    },
  }),
}));
