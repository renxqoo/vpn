/** 生命周期记录使用进程出生时间，避免 PID 复用误认原内核。 */
export async function processBirth(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const child = Bun.spawn(['ps', '-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdout: 'pipe', stderr: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
    try {
      const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return code === 0 ? text.trim() || undefined : undefined;
    } finally { clearTimeout(timer); }
  } catch (_e) { return undefined; }
}

export async function processAlive(pid: number, birth?: string): Promise<boolean> {
  try { process.kill(pid, 0); } catch (e) {
    return (e as { code?: string }).code !== 'ESRCH';
  }
  if (birth) {
    const current = await processBirth(pid);
    if (current && current !== birth) return false;
  }
  return true;
}
