# start 后台守护模式（--daemon）方案

> 状态：定稿
> 级别：中（新外部契约 flag + 子进程生命周期语义 + 跨模块 cli/start/system）
> 关联：docs/design.md §1.1；docs/port-conflict.md（错误形态沿用）

## 契约

- CLI：`bun-clash start --daemon [其余 start 参数原样透传]`
  - 父进程行为：spawn detached 子进程运行 `start`（剥掉 `--daemon`），stdio 追加到
    `~/.vpn/logs/kernel.log`，轮询就绪信号，就绪后自身退出；
  - 就绪信号：`~/.vpn/controller.json` 出现且其 `pid` 等于子进程 pid 且进程存活
    （复用 `readRunningController` 的活性校验语义，但不要求 API 端口——避免对
    `resolveController` 的网络探测产生二次依赖）；
  - 退出码：就绪 → 0（stdout 打印端口摘要与日志路径）；已在运行 → 1；
    子进程早退 → 1（附日志尾 ≤15 行）；就绪超时 → 1（SIGTERM 子进程后报错）；
  - 错误形态：沿用 CLI 现有 `fatal: <原因>`（main catch），不新增错误结构。
- 时序：一次性事件恰好一次——`controller.json` 只由子进程写（现有 `writeController`），
  父进程只读；父进程退出不向子进程发信号（detached + unref）。
- 握手：daemon 父进程给子进程注入环境变量 `BUN_CLASH_DAEMON=1`；子进程
  `writeController` 将 `daemon: true` 落进 `controller.json`（bool，可选字段，
  旧文件缺省视为前台）——status 据此展示运行方式。
- `bun-clash status` 增补（纯展示，无行为变化）：内核运行中时展示
  `前台 / 后台守护`（来自 controller.daemon）、`PID`；后台守护追加
  `日志路径 ~/.vpn/logs/kernel.log`。

## 问题域

- 处理：后台启动、就绪等待、早退报告（日志尾）、超时终止、`~/.vpn/logs/` 目录创建。
- 不处理（写清归属）：
  - 崩溃自动重启/supervision——用户手动 `bun-clash start` 重启；若需开机自启属
    launchd 集成，另立功能；
  - 日志轮转——`kernel.log` 追加不截断，无限增长由用户清理（轮转超纲）；
  - Windows job 对象/服务化——本项目 V1 仅 macOS。

## 并发/一致性预算

- 就绪轮询：间隔 100ms，硬超时 60s（geoip mmdb 下载 30s 超时 + 订阅拉取余量）；
- 父进程对子进程：唯一持有者；超时路径 SIGTERM 后最多再等 5s 放弃等待（不 SIGKILL，
  保留其系统代理恢复逻辑执行机会）；
- 无写竞争：父进程不写任何状态文件。

## 拆分

- `src/system/daemon.ts`（新）：`runDaemonStart({ entry, args })` + 可注入依赖的
  `waitForReady({ child, readController, alive, timeoutMs, pollMs })`（超时路径单元可测）；
- `src/config/paths.ts`：新增 `LOG_DIR()` / `KERNEL_LOG_PATH()`（单一真相，status 与
  daemon 共用）；
- `src/config/controller.ts`：Controller 增可选 `daemon?: boolean`（校验：存在必须为
  bool），`writeController` 增第三参；
- `src/config/status.ts`：运行行展示运行方式/PID/日志路径；
- `src/cli.ts`：start 命令拦截 `--daemon`（parseStartArgs 不认识它，须在分发前剥离），
  `entry: import.meta.path` 传入（源码 .ts / 构建 .js 均可直接被 bun 执行）；
- 依赖方向：cli → system/daemon → config/controller、config/paths、system/process（只读复用）。

## 实施顺序

1. daemon.ts + 单元测试（waitForReady 三态：就绪/早退/超时）；
2. cli 集成 + controller.daemon 落盘 + status 展示；
3. e2e（happy / 已在运行 / 端口占用早退）；
4. help/README 文案。
   验收点：每阶段四门全绿；无过渡态（flag 是纯加法）。

## 裁决

- **opt-in `--daemon`，默认仍前台**（默认裁决：不 breaking 现有用法；否决窗口——
  若要默认后台请提出）；
- **日志追加不截断**（默认裁决：保留多代历史便于排障）；
- **无 supervision**（默认裁决：V1 保持简单）。

## 测试口径

- 单元（tests/system/daemon.test.ts）：waitForReady 表驱动——
  就绪（controller 出现+pid 匹配+alive）/ pid 不匹配不判就绪 / 早退先于就绪 /
  超时触发且收到终止指令 / 存活校验失败不判就绪；
- e2e（tests/e2e/daemon.test.ts，复用 start-cleanup 的 temp-HOME + 本地订阅源装置）：
  1. happy：`start --daemon --no-system-proxy` + 全 0 端口 → 父 exit 0、controller 就绪
     且 daemon=true、子进程脱离父进程存活、API 可达，`status` 输出含「后台守护」与
     PID，随后 shutdown 清理无残留；
  2. 已在运行：先 daemon 起一个，再 daemon → exit 1 + 「已在运行」；
  3. 早退：订阅正常但 HTTP 端口被占 → exit 1 + 输出含「监听失败」与日志尾；
- 回归：现有 start-cleanup 两用例不回归。

## 验收清单

- [ ] 契约：flag 透传、退出码四态、日志路径、就绪定义
- [ ] 边界：已在运行 / 端口占用早退 / 60s 超时 / logs 目录不存在自动创建
- [ ] 预算：轮询 100ms、超时 60s、SIGTERM 后 ≤5s 放弃
- [ ] 四门 + e2e 旅程绿；对抗审查问题清零
