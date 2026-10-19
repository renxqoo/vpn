/** 稳定文件上的内核锁；描述符可继承给命令，覆盖主进程崩溃后的命令寿命。 */
import { closeSync, openSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';

export interface SystemLock { fd?: number; release(): Promise<void> }
export type AcquireSystemLock = (path: string) => Promise<SystemLock>;
let library: { symbols: { flock(fd: number, operation: number): number } } | undefined;

export const acquireSystemLock: AcquireSystemLock = async (path) => {
  if (process.platform !== 'darwin') throw new Error('system proxy lock requires macOS');
  library ??= dlopen('/usr/lib/libSystem.B.dylib', {
    flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
  });
  const fd = openSync(path, 'a', 0o600);
  if (library.symbols.flock(fd, 2 | 4) !== 0) { // LOCK_EX | LOCK_NB
    closeSync(fd);
    throw new Error('system proxy operation busy or lock unavailable');
  }
  // 只关闭父描述符，不主动 LOCK_UN；在途命令持有的副本仍保护恢复过程。
  return { fd, release: async () => { closeSync(fd); } };
};
