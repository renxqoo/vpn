/** 真正的延迟子进程，仅改临时目录；模拟主进程死后仍在执行的 networksetup。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeNetwork } from '../helpers/system-proxy-fake.ts';

const root = process.argv[2]!;
writeFileSync(join(root, 'fake-native-started'), '1');
await Bun.sleep(800);
const path = join(root, 'fake-network.json');
const network = new FakeNetwork();
network.services = JSON.parse(readFileSync(path, 'utf8')) as typeof network.services;
await network.run(JSON.parse(process.argv[3]!) as string[]);
writeFileSync(path, JSON.stringify(network.services));
writeFileSync(join(root, 'fake-native-finished'), '1');
