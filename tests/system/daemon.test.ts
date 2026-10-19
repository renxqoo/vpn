import { describe, expect, test } from 'bun:test';
import { waitForReady } from '../../src/system/daemon.ts';

/** 可编程替身：手动推进轮询循环，测超时/早退/就绪三态与预算纪律；kill 即结算 exited */
interface FakeChild {
  pid: number;
  exited: Promise<number>;
  kill(sig?: number | string): void;
}

function fakeChild(opts: { exitAfterMs?: number; exitCode?: number } = {}): FakeChild {
  let settle: (code: number) => void = () => {};
  const child: FakeChild = {
    pid: 4242,
    exited: new Promise((resolve) => { settle = resolve; }),
    kill() { settle(opts.exitCode ?? 0); },
  };
  if (opts.exitAfterMs !== undefined) {
    const t = setTimeout(() => settle(opts.exitCode ?? 1), opts.exitAfterMs);
    void t.unref?.();
  }
  return child;
}

function controllerFixture(overrides: Partial<{ pid: number; alive: boolean }> = {}) {
  const pid = overrides.pid ?? 4242;
  const alive = overrides.alive ?? true;
  let available = false;
  return {
    publish() { available = true; },
    async read() {
      if (!available) return null;
      return { pid, apiPort: 9090, secret: '' };
    },
    aliveFn: async () => alive,
  };
}

describe('waitForReady（就绪/早退/超时三态）', () => {
  test('controller 出现 + pid 匹配 + 进程存活 → 就绪', async () => {
    const child = fakeChild();
    const fx = controllerFixture();
    const result = await Promise.all([
      waitForReady({ child, readController: fx.read, alive: fx.aliveFn, timeoutMs: 2_000, pollMs: 5 }),
      (async () => { await Bun.sleep(20); fx.publish(); })(),
    ]).then(([r]) => r);
    expect(result.ready).toBe(true);
    child.kill();
  });

  test('controller pid 与子进程 pid 不匹配 → 不判就绪（超时路径）', async () => {
    const child = fakeChild();
    const fx = controllerFixture({ pid: 9999 });
    fx.publish();
    const result = await waitForReady({ child, readController: fx.read, alive: fx.aliveFn, timeoutMs: 60, pollMs: 5 });
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.reason).toBe('timeout');
    child.kill();
  });

  test('进程存活校验失败（pid 复用）→ 不判就绪', async () => {
    const child = fakeChild();
    const fx = controllerFixture({ alive: false });
    fx.publish();
    const result = await waitForReady({ child, readController: fx.read, alive: fx.aliveFn, timeoutMs: 60, pollMs: 5 });
    expect(result.ready).toBe(false);
    if (!result.ready) expect(['timeout', 'early-exit']).toContain(result.reason);
    child.kill();
  });

  test('子进程早退先于就绪 → early-exit，带退出码', async () => {
    const child = fakeChild({ exitAfterMs: 10, exitCode: 1 });
    const fx = controllerFixture();
    const result = await waitForReady(
      { child, readController: fx.read, alive: fx.aliveFn, timeoutMs: 2_000, pollMs: 5 });
    expect(result.ready).toBe(false);
    if (!result.ready && result.reason === 'early-exit') {
      expect(result.code).toBe(1);
    } else {
      throw new Error('expected early-exit');
    }
  });

  test('超时 → timeout，且对子进程发出终止指令', async () => {
    const child = fakeChild();
    const fx = controllerFixture();
    const kills: string[] = [];
    child.kill = (sig) => { kills.push(String(sig ?? 'default')); };
    const result = await waitForReady({ child, readController: fx.read, alive: fx.aliveFn, timeoutMs: 60, pollMs: 5 });
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.reason).toBe('timeout');
    expect(kills).toContain('SIGTERM');
  });
});
