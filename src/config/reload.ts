/** 通知本机内核重新读取订阅；结果区分未运行与刷新失败。 */
export async function hotReload(
  apiPort: number,
  secret = '',
): Promise<'reloaded' | 'not-running' | 'failed'> {
  const headers = secret ? { authorization: `Bearer ${secret}` } : undefined;
  try {
    const probe = await fetch(`http://127.0.0.1:${apiPort}/version`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (!probe.ok) return 'failed';
  } catch (_e) {
    return 'not-running';
  }
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/configs/reload`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(90_000),
    });
    return res.status === 204 ? 'reloaded' : 'failed';
  } catch (_e) {
    return 'failed';
  }
}
