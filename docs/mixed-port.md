# mixed-port 混合端口方案

> 状态：定稿
> 级别：中（新外部配置契约 + 新入站模块 + App 装配变化）
> 关联：docs/design.md §1.2/§1.3（HTTP/SOCKS5 入站既有实现）

## 契约

- 配置来源三级（优先级高→低）：CLI `--mixed-port N` > .env `MIXED_PORT` > ~/.vpn/config.yaml `mixed-port: N`
- 语义：设置了 mixed-port 时**只启动一个混合监听器**（不再单独起 HTTP/SOCKS 监听）；
  同一端口按首字节自动分流：`0x05` → SOCKS5；否则（ASCII 文本）→ HTTP 代理
- 既有 `port` / `socks-port` 键保留原语义（未设 mixed-port 时行为完全不变——零破坏）
- 展示契约：`start` 就绪行与 `status` 显示「混合端口 N」单行（替代 HTTP/SOCKS 两行）；
  `app.httpPort` 与 `socksPortForTest` 均返回混合端口（系统代理 HTTP/SOCKS 都指它）
- 错误形态：监听失败沿用 startListener 文案（`--mixed-port` 提示）

## 问题域

- 处理：首字节嗅探分流、双协议 handler 复用、配置解析三级合并、App 单监听装配。
- 不处理：
  - SOCKS4（V1 明确不支持，legacy）；
  - 订阅 yaml 内 `mixed-port` 键（端口是本机关注点，家目录/.env/CLI 已全覆盖；
    订阅含该键继续走既有「not supported in V1」警告路径）；
  - UDP ASSOCIATE（沿用 SOCKS5 既有拒绝行为）。

## 并发/一致性预算

- 嗅探阶段复用 HANDSHAKE_TIMEOUT 30s：首字节到达即路由，不增加新超时类；
- 委托后协议状态机完全复用既有实现（含早期数据缓冲 / MAX_HEADER / 空闲超时），
  混合层不持有连接级缓冲（首 chunk 即路由，无聚合）。

## 拆分

- `src/inbound/http.ts` / `socks5.ts`：`handler()` 改 public（仅可见性变化，逻辑零改动）；
- `src/inbound/mixed.ts`（新）：MixedInbound——持有 Http/Socks 实例（不 start，只取
  handler），WeakMap<socket, handler> 记录路由决定，open/data/close/error 委托；
- `src/config/settings.ts`：parseHomeKeys 增 `mixed-port` 正则；mergeSource 增 `MIXED_PORT`；
  BuildOptions.cli 增 `mixedPort`；overrides 增 `mixedPort?: number`（undefined = 未启用）；
- `src/app.ts`：overrides.mixedPort 非空时 startListener('Mixed', ...) 单监听，
  httpPort/socksPortForTest 返回混合端口；
- `src/start.ts`（parseStartArgs `--mixed-port` + 就绪行）、`src/config/status.ts`（展示）。

## 实施顺序

1. http/socks handler 可见性 + mixed.ts + 单测（嗅探决策：0x05→socks、GET→http、
   委托后状态正确）；
2. settings/app/start/status 接线 + e2e（App 装配 mixedPort：同端口 curl HTTP 代理 ✓ +
   SOCKS5 握手 ✓；未设 mixedPort 时双端口行为不回归）；
3. 用户配置迁移 + 真机验收。
   每阶段四门全绿；无过渡态（键是纯加法，旧键语义不变）。

## 裁决

- 首字节嗅探规则 `0x05→SOCKS5，其余→HTTP`（默认裁决，与 Clash/mihomo 一致）；
- 设置 mixed-port 后**不再**同时监听独立 HTTP/SOCKS 端口（用户裁决：「全部都是 7891」；
  避免三端口并存的暴露面）。

## 测试口径

- 单元（tests/inbound/mixed.test.ts）：
  - 决策：首字节 0x05 → socks handler；'GET '/'CONNECT' → http handler；
  - 路由后后续 chunk 全部进同一 handler（WeakMap 命中）；
  - 未决阶段 close 不炸（无协议状态可清理）；
- e2e（tests/e2e/mixed-port.test.ts）：
  - App mixedPort=自动端口：curl -x http://127.0.0.1:P（HTTP 代理语义）出网 ✓；
    socks5 握手 + 回环 echo ✓；
  - httpPort === socksPortForTest === 混合端口；
  - 回归：不设 mixedPort 的既有用例（start-cleanup 等）不回归。

## 验收清单

- [ ] 契约：三级配置合并、单监听、两 getter 返回混合端口、就绪行/status 展示
- [ ] 边界：未设 mixedPort 行为不变；SOCKS4 首字节（0x04）走 HTTP 路径按 400 拒绝
- [ ] 预算：嗅探 30s 超时、无混合层缓冲
- [ ] 四门 + e2e；用户真机：7891 单端口同时服务系统代理 + git
