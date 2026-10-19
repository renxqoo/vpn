/** 子进程测试只截获交互列表，不实际选择节点。 */
import { mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cancelled = Symbol('cancelled');
mock.module('@clack/prompts', () => ({
  intro() {}, cancel() {},
  isCancel: (value: unknown) => value === cancelled,
  select: async (input: { options: unknown[] }) => {
    const path = join(process.env.USERPROFILE ?? process.env.HOME!, 'node-options.json');
    writeFileSync(path, JSON.stringify(input.options));
    return cancelled;
  },
}));
