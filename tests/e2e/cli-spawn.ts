/** CLI 子进程 e2e 的平台边界：win32 上 Bun 运行时无法从 bun-test 进程 spawn TS 主模块子进程。 */
export const cliSpawnE2eSupported = process.platform !== 'win32';

export const CLI_SPAWN_SKIP_REASON =
  'bun 1.4.3 win32 cannot spawn a TS entrypoint child from a bun-test process ' +
  '(silent exit 0, zero output; runtime bug isolated via CI diagnostics D1-D18). ' +
  'CLI journeys are covered on macOS/ubuntu CI; in-process App-level tests cover wiring on win32.';
