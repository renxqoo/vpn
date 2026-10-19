/** 命令监护进程继承同一个 flock，禁止崩溃后迟到的写入越过恢复。 */
const GUARD = `
import {fstatSync} from 'node:fs';
fstatSync(3);
const child = Bun.spawn(JSON.parse(process.argv[1]), {stdio: ['ignore', 'inherit', 'inherit']});
const timer = setTimeout(() => child.kill('SIGKILL'), Number(process.argv[2]));
try { process.exitCode = (await child.exited) || 0; }
finally { clearTimeout(timer); }
`;

export async function runLockedCommand(command: string[], fd?: number, timeout = 10_000): Promise<string> {
  const locked = fd !== undefined;
  // 超时器也由持锁进程监护，主进程强杀后仍可结束卡住的 native 命令并释放锁。
  const argv = locked ? [process.execPath, '-e', GUARD, JSON.stringify(command), String(timeout)] : command;
  const child = Bun.spawn(argv, {
    env: { ...process.env, LC_ALL: 'C' }, detached: locked,
    stdio: ['ignore', 'pipe', 'pipe', fd ?? 'ignore'],
  });
  const timer = setTimeout(() => {
    // 同时结束锁监护进程和被监护命令，不能只结束锁持有者。
    try {
      if (locked) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (_e) { /* 已退出 */ }
  }, timeout + (locked ? 1500 : 0));
  try {
    const [code, out, err] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`system command failed: ${(err || out).trim().slice(0, 200)}`);
    return out;
  } finally { clearTimeout(timer); }
}
