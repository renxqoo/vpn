# bun-clash

用 TypeScript + Bun 1.4.3 实现的 Clash 兼容代理内核（零第三方依赖）。加载你的 Clash 订阅，
在本地提供 HTTP/SOCKS5 代理入站，按规则分流到 AnyTLS 节点或直连。

## 安装

**全局安装（本项目开发形态）**：

```bash
cd /path/to/vpn && bun link     # 软链安装——源码改动即时生效
bun-clash help                  # 全局命令可用
```

**npm 发布后**：

```bash
bun add -g bun-clash            # 或 npm i -g bun-clash
```

## 快速开始

```bash
# 1. 写入订阅（首次）——写到 ~/.vpn/config.yaml
bun run cli config set-subscription 'https://example.com/link/xxx?clash=1'

# 2. 启动
bun run start                          # 启动内核并自动配置/开启 macOS 系统代理
bun run start --direct                 # 不用订阅，代理内核全部直连
bun run start --no-system-proxy        # 仅启动内核，手动配置系统代理
bun run stop                           # 恢复原系统代理并停止内核
bun run cli proxy off                  # 仅恢复原系统代理，内核继续运行
bun run cli nodes --check              # 轻量探测每个节点的延迟和可用状态，不切换节点
bun run cli nodes --list               # 查看完整节点表（最近探测结果）
bun run start --port 7890 --api-port 9090    # 端口覆盖
bun run config show                    # 查看当前生效配置与来源
```

首次启动且没有订阅时：自动生成 `~/.vpn/config.yaml`（空订阅），以直连模式启动并打印引导，
使用 `config set-subscription` 更新后会同步运行配置（旧版本内核需要先重启一次）。

**dev 调试**：项目根放 `.env` 即优先于家目录配置：

```bash
SUBSCRIPTION_URL=https://example.com/link/xxx?clash=1
# 可选端口覆盖
# PORT=17890
# SOCKS_PORT=17891
# API_PORT=19090
```

启动后：

- HTTP 代理：`127.0.0.1:7890`
- SOCKS5 代理：`127.0.0.1:7891`（支持域名请求，no-auth）
- REST API：`127.0.0.1:9090`（Clash 兼容子集；强制仅监听回环）

验证：

```bash
curl -x http://127.0.0.1:7890 http://cp.cloudflare.com/generate204 -o /dev/null -w '%{http_code}\n'
# 204
```

macOS 的 `start` 默认为所有启用的网络服务设置系统代理：HTTP/HTTPS 使用实际 HTTP 监听端口，
SOCKS 使用实际 SOCKS 监听端口，暂时关闭 PAC 和自动发现。`stop` 或 Ctrl-C 会恢复启动前的设置，
然后退出；`proxy off` 只恢复系统代理。原来已开启的其它代理会随恢复重新生效。

快照保存在 `~/.vpn/system-proxy.json`。进程被强制终止后，可用 `bun run cli proxy off` 或
`bun run stop` 恢复；恢复失败会保留快照供重试。需要有修改 macOS 网络设置的权限；原代理带认证时
不会自动接管，可使用 `--no-system-proxy`。Linux/Windows 当前仅启动内核并提示手动配置代理。
系统代理管理只在启停时执行，不参与流量转发。

`nodes` 选择列表和 `status` 均展示每个节点的延迟与可用状态。`nodes --check` 手动刷新全部节点，
`nodes --check --node '节点名'` 只探测一个节点。探测最多4项并发，每节点总时限3秒，仅发送轻量 HEAD，
不下载测速文件、不切换当前节点。普通列表/status 读取内核缓存，不触发探测。
没有样本显示“未探测”，失败显示“不可用/超时”，超过5分钟的结果标注“上次结果”；重启内核会清空探测结果。

## 配置

两层来源（优先级从高到低）：

1. **`.env`**（项目根，dev 调试）：`SUBSCRIPTION_URL` + 可选 `PORT/SOCKS_PORT/API_PORT`
2. **`~/.vpn/config.yaml`**（正式）：`subscription-url: '...'`（`bun run cli config set-subscription` 写入）

订阅即 Clash YAML——端口、节点（anytls）、策略组（select/url-test/fallback）、规则
（DOMAIN/DOMAIN-SUFFIX/DOMAIN-KEYWORD/IP-CIDR/IP-CIDR6/GEOIP/RULE-SET/MATCH）、
rule-providers（http，domain/ipcidr/classical）都会被解析并生效。
dns/sniffer/tun 等键在 V1 中忽略（有警告日志）。

缓存目录 `~/.vpn/cache/`：订阅快照按 URL 隔离、rule-provider 规则集、geoip mmdb（跟随家目录）。

更新订阅地址用 `bun run cli config set-subscription 'https://...'`，会同时更新已配置订阅的
项目 `.env` 与家目录配置，并同步运行中的节点、策略组及规则。新订阅会清除旧节点选择；
同地址更新时保留仍有效的选择，移除失效项。`bun run cli nodes` 选择节点后也会刷新运行配置。
直接编辑配置文件后，运行 `nodes` 或重启生效。重载保持监听端口和运行模式，复用未变节点的连接池；旧节点已有连接自然结束，新连接使用新配置；
下载失败可使用同地址已验证的缓存，新地址不能使用旧地址的缓存。

## REST API（Clash 兼容子集）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /version | `{"version":"1.0.0"}` |
| GET | /proxies | 全部代理与组 |
| GET | /proxies/:name | 单个（含 now/all/history） |
| PUT | /proxies/:name | `{"now":"节点名"}` 切换 select 组 |
| POST | /system-proxy/off | 恢复系统代理，内核继续运行 |
| POST | /proxies/:name/healthcheck | 手动探测单节点延迟，最多4项并发 |
| POST | /shutdown | 先恢复系统代理，响应后停止内核 |
| POST | /configs/reload | 从当前进程配置来源重新加载订阅；204 成功，400 失败，409 刷新中 |
| GET | /rules | 规则列表 |
| GET | /connections | 活动连接 |
| DELETE | /connections/:id | 关闭连接 |

配置了 `secret` 时需要 `Authorization: Bearer <secret>`。

## 支持的协议

- **出站**：AnyTLS（协议 v2：会话多路复用、padding scheme、SYNACK、心跳、
  UpdatePaddingScheme）、DIRECT。其他类型（vmess/trojan/ss 等）标记为不可用并在选择时跳过。
- **入站**：HTTP 代理（CONNECT + 绝对形式）、SOCKS5（no-auth，CONNECT；UDP 不支持）。

V1 明确不做（不装已实现的样子）：DNS/fake-ip、UDP 代理、TUN、sniffer、
TLS client-fingerprint 伪装。见 docs/design.md §0。

## 功能总览

- **代理内核**：AnyTLS 出站（会话多路复用、padding、SYNACK/心跳）、HTTP/SOCKS5 入站、
  规则路由（domain/ipcidr/geoip/ruleset）、策略组（select/url-test/fallback）、模式热切换
  （规则/全局/直连，`PATCH /configs`）
- **可观测**：每节点探测历史（延迟/成功率）、连接级双向字节计量与会话累计、
  `status` 一屏展示运行态（模式/出口/延迟/实时网速/会话流量/各地区节点健康）
- **CLI**：`start` / `stop` / `proxy off` / `nodes`（交互 + `--node` 非交互）/ `mode`（交互 + `--set`）/
  `usage`（订阅余量与到期）/ `status` / `config`
- **平台**：macOS / Linux / Windows（CI 三平台跑 check/lint/build/test）

## 开发

```bash
bun run check      # 类型检查（bun check）
bun run lint       # 自研 lint（0 警告 0 错误）
bun run fmt        # 自研格式化（--check 为门禁模式）
bun run build      # bun build 打包 dist/main.js
bun test tests     # 全部测试（132 个；本地 AnyTLS 测试服务端回环）
bun run test:real  # 真实节点冒烟（REAL_SMOKE=1，对订阅前 3 个地区节点请求 204）
```

四门（check/lint/build/test）在每次提交前必须全绿。设计文档与测试口径在 `docs/`。

## 目录

```
src/
  main.ts / app.ts        CLI 与装配
  config/                 YAML 子集解析、Clash 配置、订阅拉取
  rules/                  规则引擎、rule-providers、geoip、策略组
  outbound/anytls/        AnyTLS 客户端（会话/流/padding）+ 测试服务端
  inbound/                HTTP / SOCKS5 入站
  api/                    REST API
tools/                    自研 lint / fmt
tests/                    单测 + e2e（镜像 src 布局）
```

回环性能对照：`bun run tools/bench-vpn.ts`（本地 TLS 回显吞吐及“重载 + 建连 + 128B 回显”耗时）。
测量口径、原始结果和资源复用契约见 [性能方案](docs/vpn-performance.md)。
