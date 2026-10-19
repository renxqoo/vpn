/** 启动阶段保留监听种类、完整端点和系统错误码，不进入流量转发路径。 */
export async function startListener(
  kind: 'HTTP' | 'SOCKS5' | 'Mixed' | 'API', port: number, start: () => Promise<void>,
): Promise<void> {
  try { await start(); } catch (cause) {
    const error = cause as { code?: string; message?: string } | null;
    const code = error?.code ?? 'UNKNOWN';
    const reason = code === 'EADDRINUSE' ? '端口已被占用' : error?.message ?? String(cause);
    const flag = kind === 'HTTP' ? '--port'
      : kind === 'SOCKS5' ? '--socks-port'
        : kind === 'Mixed' ? '--mixed-port'
          : '--api-port';
    throw new Error(`${kind} 监听失败：127.0.0.1:${port}（${code}：${reason}）；可用 ${flag} 指定其它端口`, { cause });
  }
}
