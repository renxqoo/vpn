# bun-clash — Clash 兼容代理内核（TypeScript + Bun）

- 状态：**草稿 → 已实施**（实现随方案演进，定稿裁决见各项「裁决」）
- 日期：2026-10-19
- 分级：**大**（新子系统：协议栈 + 入站服务 + 路由 + 配置面）。按 feature-dev-v2 §2 大级「借件」裁
  决——交付物是全新能力，无存量行为基线需要守护；借迁移方法论的文档结构纪律，不整体转入。

## 0. 目标与非目标

### 目标（V1 全部实现，不留占位）

用 Bun 1.4.3（零第三方依赖）实现一个 Clash 兼容的代理内核，可加载用户提供的订阅
`<订阅地址（用户提供，含 token，不入库）>`（34 个 anytls 节点、8 个策略组、
76 条规则、21 个 rule-providers），提供：

1. **AnyTLS 出站**（协议 v2）：TLS → sha256 认证 → 会话多路复用（SYN/PSH/FIN/Settings/
   SYNACK/心跳/UpdatePaddingScheme），会话池复用 + 空闲清理 + padding 引擎；
2. **入站**：HTTP 代理（CONNECT 与绝对形式）+ SOCKS5（no-auth CONNECT）；
3. **路由**：DOMAIN/DOMAIN-SUFFIX/DOMAIN-KEYWORD/RULE-SET(behavior=domain/ipcidr/classical)/
   IP-CIDR(6)/GEOIP/MATCH，`no-resolve` 标志；
4. **策略组**：select / url-test / fallback；
5. 配置加载（自研 YAML 子集解析器）、订阅拉取（带 User-Agent）与缓存、rule-providers 拉取缓存；
6. REST API（Clash 兼容子集：proxies/切换/rules/connections）；
7. `bun run start` 一条命令跑起来。

### 明确不处理（V1 不做、不装已实现的样子）

| 项 | 理由 | 归属 |
| --- | --- | --- |
| TUN/系统代理/redir/tproxy 接管 | 系统层侵入，超出「程序」边界 | 用户手动配系统代理指向 127.0.0.1:7890 |
| DNS 模块（fake-ip/DoH/fallback-filter） | 独立子系统，V1 的规则匹配用解析出的 IP | 见 §6「后续」 |
| UDP 代理（udp-over-tcp 2） | 订阅节点虽标 udp:true，但 V1 只做 TCP 代理 | §6 |
| TLS client-fingerprint（uTLS 指纹伪装） | Bun TLS 用 BoringSSL 指纹，uTLS 级伪装超出 V1 | §6 |
| sniffer（协议嗅探还原域名） | fake-ip 不做时嗅探无落点 | §6 |
| 多协议出站（vmess/trojan/ss/hysteria…） | 订阅里只有 anytls | §6 |
| GEOIP mmdb 之外的 ASN/GEOSITE/多库 | V1 只需 CN + LAN 的 country 判断 | §6 |
| Clash API 的 providers 端点、delay 测试历史图 | 非必需 | §6 |
### 已知风险与实测边界（探查结论，作为契约的一部分）

- `bun fmt` / `bun lint` 在 1.4.3 **不是**内置命令（报 Script not found）；npm registry 被
  沙箱拦截（000），无法安装第三方 linter/formatter。**裁决**：四门中的 fmt/lint 用零依赖
  自研脚本实现（tools/fmt.ts 规范化排版 + tools/lint.ts 规则检查），挂进 package.json
  script（`bun run fmt` / `bun run lint`），不引第三方依赖。（用户环境如有全局插件可覆盖。）
- 真实节点 TLS 全部可达（1150ms/117ms/127ms），支持 rejectUnauthorized:false + 自定义 SNI；
  Bun TLS 服务端需要 **RSA 证书**（EC 密钥 BoringSSL 解码失败）——本地测试服务端用 RSA。
- 订阅源与 jsdelivr（fastly/cdn）可达；GitHub raw 与 npm 不可达。rule-providers 的 .txt
  文本格式即 Clash 经典 payload 列表（`payload:\n  - 'x'`）。

## 1. 外部契约

### 1.1 CLI

```
bun run start [--port <n>] [--socks-port <n>] [--api-port <n>] [--direct]
  --direct      跳过订阅/节点，全部直连（调试用）
  --port/--socks-port/--api-port  覆盖配置内端口
```

**CLI 正规化为可发布形态（用户裁决 2026-10-19 第三批）**：

- 仓库提供单一 bin 入口 `src/cli.ts`（`#!/usr/bin/env bun`），package.json 声明
  `"bin": {"bun-clash": "src/cli.ts"}`——npm 发布后全局命令为 `bun-clash <子命令>`；
  仓库内 dev 形态 `bun run cli <子命令>`（package.json script 指向同一入口，不再每个
  子命令一条 script）。
- 子命令：`start`（原主程序）、`nodes`、`usage`、`config`、`mode`、`help`。
  `src/main.ts` 只保留 start 职责（被 cli 调用），不再是入口。
- **代理模式切换**（第二批追加）：`bun run cli mode` 交互选择 规则(rule) / 全局(global) /
  直连(direct)——写 `~/.vpn/config.yaml` 的 `mode:` 键；内核运行中（API 可达）时通过
  内核内部接口热切换。REST API 新增 `PATCH /configs`（Clash 兼容语义）：
  `{"mode":"rule"|"global"|"direct"}`，运行时切换路由模式（不入持久配置——重启后以
  配置文件为准，与 Clash 行为一致）。启动时 `global` 模式的出站选择：优先 `selected-node`
  指定节点，否则第一个 anytls 节点。
- **运行时依赖与布局坑**：@clack/prompts 依赖树在 Bun 1.4.3 嵌套安装布局下有解析 bug
  （cache 实体缺 node_modules），已在开发机修复并登记（§7）；发布包不受影响（npm
  安装方使用自身布局）。

**交互式 CLI（用户裁决 2026-10-19 第二批）**：`nodes`（交互选择节点）与
`usage`（订阅用量）：

- `nodes`：@clack/prompts 交互列表——分组列出订阅节点（地区分组），选择后写回
  `~/.vpn/config.yaml` 新增的 `selected-node: '节点名'` 键（持久化），并提示需要重启生效；
  若内核正在运行（API 端口可达），同时调 `PUT /proxies/🚀 节点选择` 热切换（免重启）。
- `usage`：拉订阅响应头 `subscription-userinfo`（upload/download/total/expire），
  展示已用/总量/剩余（GB 与百分比进度条）+ 到期时间与剩余天数；头部缺失时明确提示。
- 新增配置键 `selected-node`：启动时若存在，把名为 `🚀 节点选择` 的 select 组初始选中该节点；
  API 热切换后由 CLI 写回该键（下次启动保持一致）。
- `@clack/prompts` 为唯一第三方运行时依赖（npm 时通时断，已装齐；CI 断网时 CLI 降级为纯文本编号选择——存疑项，V1 先不做降级，登记遗留）。

**配置来源分层（用户裁决 2026-10-19）**：

1. **dev 调试**：项目根 `.env`——`SUBSCRIPTION_URL=...`（+可选端口覆盖 `PORT/SOCKS_PORT/API_PORT`）。
   存在 `.env` 时优先于家目录配置（`bun run start` 在项目里即调试形态）。
2. **正式**：`~/.vpn/config.yaml`（不存在则在首次启动自动生成空订阅版——订阅地址留空）。
3. **写配置命令**：`bun run config set-subscription <URL>` 把订阅地址写入 `~/.vpn/config.yaml`
   （目录不存在则创建）；`bun run config show` 输出当前生效配置与来源。
4. **首次启动且订阅为空**：不报错退出，打印引导（提示 config set-subscription 命令）后以
   全直连模式启动（端口用默认），等用户写入订阅后重启即走订阅。

- 启动成功输出监听地址与配置来源；SIGINT/SIGTERM 优雅退出（关停入站、清理会话）。
- 启动失败（订阅拉取失败且无缓存、配置语法错）→ 打印错误，exit 1。
- `--config` 参数移除（配置来源只有 .env 与 ~/.vpn/config.yaml 两级，不留双轨）。

### 1.2 HTTP 代理行为

- `CONNECT host:port` → 200 Connection Established（裸隧道）。
- 绝对形式 `GET http://x/y` → 转发请求（重写 request-line 为 origin 形式）→ 流式响应回写。
- 目标不可达 → 502；规则拒绝 → 407/403 body `blocked by rule`。
- 保持逐请求路由判定（同一客户端连接上不同目标可走不同出口）。

### 1.3 SOCKS5 行为

- 方法协商只支持 `00 no-auth`（返回 ffffffff 失败）；CONNECT 命令；BND.ADDR 回 0.0.0.0:0；
- 请求域名时用域名字符串做规则匹配（不解析）；请求 IP 时直接匹配 IP 角则。
- UDP ASSOCIATE 不支持 → REP=0x07 command not supported。

### 1.4 AnyTLS 出站（对真实服务端的兼容契约）

字节级语义（对齐 anytls-go@main 参考，字节序均为大端）：

- 认证：`sha256(password) || u16be(padding0len) || padding0`，padding0len 取 padding scheme
  第 0 项的随机值（30-30 固定 30）；
- 帧：`u8 cmd || u32be streamId || u16be len || data`；cmd 表见协议文档；
- 新会话先发 cmdSettings（`v=2`、`client=bunclash/1.0.0`、`padding-md5=<md5>`，行协议
  `k=v\n`，顺序：v/client/padding-md5）；
- cmdSYNACK 无 data = 成功；有 data = 错误文本，流读端收到 REMOTE 错误；
- cmdFIN：本端收到 FIN → 关闭本地流不回 FIN；本端流关闭 → 发 FIN；
- cmdWaste 读取丢弃；cmdAlert 打印并关闭会话；cmdUpdatePaddingScheme 更新该 Client 级
  padding scheme（校验合法才更新，md5 重算）；cmdHeartRequest → 回 HeartResponse；
- 写路径 padding：pkt 计数以「次」为单位（每次 writeConn 计一次），pkt < stop 时按 scheme
  分包（含 `c` 检查标记：剩余为 0 则停止）、不足补 cmdWaste 帧（含 7 字节帧头）；pkt 超过
  stop 后 sendPadding=false 不再处理；
- 会话池：新流优先取空闲池中 **seq 最大** 的会话；池空则新建（seq 单调递增）；流结束且会话
  未死则回池（idleSince=now）；周期清理：空闲超时阈值且超过 minIdleSession 数量才关；
  Client.Close 关全部。

### 1.5 配置契约（Clash YAML 子集）

- 顶层键：port/socks-port/mixed-port/redir-port/allow-lan/ipv6/mode/log-level/
  external-controller/secret、proxies、proxy-groups、rules、rule-providers、dns(忽略并警告)、
  sniffer/tun(忽略并警告)、geox-url(取 geoip mmdb URL)。
- 未知顶层键 → 警告不致命。未知节点 type → 该节点标记 unavailable，不崩。
- proxies 条目字段（anytls）：name/server/port/password/sni/skip-cert-verify/udp/
  client-fingerprint(忽略)/idle-session-check-interval/idle-session-timeout/min-idle-session。
- proxy-groups: select/url-test/fallback，字段 name/type/proxies/interval/tolerance/url。
- rules 行语法：`TYPE,payload[,target][,no-resolve]`，TYPE ∈ {DOMAIN, DOMAIN-SUFFIX,
  DOMAIN-KEYWORD, IP-CIDR, IP-CIDR6, GEOIP, RULE-SET, MATCH}。
- rule-providers: type=http（file 类型读本地文件），behavior ∈ {domain,ipcidr,classical}，
  url/path/interval/format(txt/yaml 自动识别)。
- YAML 解析器：子集 = 块映射/序列/流式映射与序列/单双引号/注释/空行/多级缩进/`---` 文档
  开始/顶层单行 JSON 风格（订阅的 proxies 实际是每行一个 JSON 流映射）。**不支持**：锚点/
  块标量/标签/多文档(取第一个)/tab 缩进（报错）。订阅实测无锚点无块标量（已验证）。
- 订阅缓存：`.cache/sub.yaml`，成功拉取后写入；启动时缓存优先级低于线上（除非离线）：
  先试线上，失败 fallback 缓存，都失败才报错；Cache-Control/subscription-userinfo 头不解析
  （V1 不做配额显示）。

### 1.6 REST API（Clash 兼容子集）

GET /proxies → 全部代理与组（含 now、history 空）；GET /proxies/:name → 单个；PUT
/proxies/:name {"now": x}（仅 select 组，url-test/fallback 拒绝 400）；GET /rules → 规则
列表；GET /connections → 活动连接列表（id/protocol/host/destinationIP/duration/upload/
download/chains）；DELETE /connections/:id → 关闭连接；GET /version → {"version":"1.0.0"}；
secret 非空时校验 Authorization: Bearer；未认证 401。API 仅监听 127.0.0.1（external-controller
里写 0.0.0.0 也强制本地——安全裁决，日志警告）。API 绑定失败不致命（警告继续跑代理）。
### 1.7 测试服务端与 fixture

- `src/anytls/testing/server.ts`：本地 AnyTLS 服务端（TLS(RSA 自签) + 认证 + 会话层 +
  逐流回显 + SYNACK/Heartbeat/UpdatePaddingScheme 下发），e2e 与开发自测用。
- fixture：`tests/fixtures/sub-real.yaml`（真实订阅快照，节选含全部语法形态）+ 真实
  rule-provider 样本。
`dns` 项忽略并警告（V1 无 DNS 模块）。

## 2. 问题域模型与模块边界

```
src/
  main.ts              CLI 入口：参数解析 → 装配 → 生命周期
  app.ts               装配：配置→Provider→Router→入站/出站/API 绑定
  config/
    yaml.ts            YAML 子集解析器（纯函数，错误带行号）
    clash.ts           Clash 配置模型 + 解析/校验（未知键警告、节点可用性标记）
    subscription.ts    订阅拉取 + 缓存（fetch with UA mihomo；部分服务拒绝旧版 Clash Verge 标识）
    clash.ts 内      节点字段标准化
  rules/
    index.ts           规则编译与匹配引擎（规则链 + RULE-SET 引用解析 + no-resolve）
    providers.ts       rule-providers 拉取/缓存/解析（payload 列表 → domain trie/suffix map/cidr）
    geoip.ts           mmdb 读取器 + mmdb 下载缓存（.cache/geoip.mmdb）
  outbound/
    direct.ts          直连
    anytls/
      frame.ts         帧编解码（纯函数）
      padding.ts       padding scheme 引擎（纯函数 + 随机源注入）
      session.ts       会话层（事件循环、流、v2 特性）
      client.ts        Client（会话池、seq、清理例程）
      index.ts         AnytlsOutbound（Clash 适配层）
      testing/server.ts 测试服务端（devDependency 性质，prod 不引用）
      testing/mkcert.ts RSA 自签证书生成（零依赖，纯 TS）
  inbound/
    http.ts            HTTP 代理入站
    socks5.ts          SOCKS5 入站
  api/
    server.ts          REST API（Bun.serve）
  core/
    types.ts           Proxy/Provider/Conn 等核心接口
    connections.ts     活动连接台账（API /connections 与关闭）
    log.ts             日志（级别、前缀，stderr）
    clock.ts           时钟与随机注入（可测试性）
  tools/
    fmt.ts             排版器（零依赖）
    lint.ts            lint 规则（零依赖）
```

- **单一真相**：帧格式常量只在 frame.ts；端口/超时缺省值只住在 config 层；socksaddr 编解码
  只在 outbound/anytls/socksaddr.ts（入站与出站共用，不双写）。socksaddr 属于 anytls 出站
  的一部分，但入站 SOCKS5 复用其编解码器。
- **零兼容层**：内部模型不保留 Clash 字段别名（如 `mixed-port` 归一到 http 端口后丢弃原键
  不留双轨）。
- **依赖方向**：inbound → core ← outbound；rules → core；api → core；main → 全部。
  testing/* 只被 tests 引用。

## 2.5 并发与资源预算

- 单个入站连接一个异步任务；不做每连接线程/进程。
- AnyTLS Client 每节点一个；每会话一个读循环任务 + 一个写序列化（socket.write 天然串行，
  与 Go 版语义一致：connLock）；SYN deadline 3s 定时器（v2）：连续 2 个在途 SYN 无 SYNACK
  则关会话（对齐参考实现的 synDone 语义）。
- 空闲清理：setInterval(idleSessionCheckInterval 默认 30s)，关闭空闲超 timeout（默认 30s）
  且数量 > minIdleSession（默认 5）的会话。
- rule-providers 刷新：setInterval(interval 默认 86400s)；GEOIP mmdb 只读加载一次（mmap 不
  适用，读入 ArrayBuffer）。
- 内存上界参考：规则域名 trie ~5MB（9 万域名），mmdb 7.6MB 堆内，单连接缓冲上限 256KB
  （超限断开，防内存放大）；每个 frame data ≤ 65535。
- 定时器预算：全局定时器数 = 节点数 × 1（清理） + providers × 1 + API 无 + 心跳 0（被动
  响应），34 节点 ≈ 55 个 interval。
- 连接台账 race：台账增删走单一 Map，API 读取走快照（事件循环单线程模型下天然原子）。

## 2.6 方向性裁决落档

| # | 裁决 | 依据 |
| --- | --- | --- |
| D1 | 零第三方依赖 | npm 不可达 + 减少攻击面；YAML/mmdb 解析器自研（已验证订阅语法子集可控） |
| D2 | fmt/lint 自研脚本挂 script | bun 1.4.3 无内置；四门不能静默缺席（feature-dev-v2 §6） |
| D3 | API 强制 127.0.0.1 | 安全默认（Clash 默认 0.0/TUN 不同，本程序 API 暴露公网无益） |
| D3b | API 绑定失败仅警告 | 运行代理优先于管理面 |
| D4 | 会话池语义对齐 anytls-go | 兼容真实服务端的行为（取最大 seq、minIdleSession 保留、SYN deadline） |
| D5 | V1 不做 DNS/UDP/TUN/sniffer | 见 §0 非目标，避免假装支持 |
| D5b | `client=bunclash/1.0.0` | 协议文档要求第三方实现填真实名称 |
| D6 | 测试服务端也是 TS（含 mkcert RSA 自签） | 零依赖闭环 + 服务端实现可当文档读 |
| D7 | 缓存策略：线上优先、离线 fallback | 订阅可能更新节点列表；离线也能跑 |
| D7b | GEOIP 从订阅 geox-url 下载 mmdb | 订阅已给 fastly.jsdelivr 源；下载失败 → GEOIP 规则跳过并警告 |
| D7c | `bun test` 覆盖率数字如实报告，不设阈值门禁 | bun 1.4.3 无阈值 flag；不伪装有门禁 |
| D8 | e2e 用本地 AnyTLS 服务端全链路（含真实订阅 fixture），真实节点冒烟 opt-in | 赫兹计费/封禁风险不进默认门禁 |
| D9 | 入站连接读缓冲上限 256KB | 防 SOCKS5/HTTP 头部无限读 |
| D9b | HTTP 入站也逐请求路由 | 同一 keep-alive 连接上不同目标可走不同出口 |

## 2.7 对抗审查关注点（预先落档）

- padding writeConn 的分包数学（CheckMark、7 字节头、remainPayloadLen-l 计算含帧头）；
- 会话池并发：流关闭钩子 vs 会话死亡竞态（dieHook 顺序）；
- SOCKS5 读恶意流（长度字段溢出、截断响应）；
- YAML 解析器对真实订阅的鲁棒性（单行 JSON 流映射、emoji 名称、引号嵌套）；
- mmdb 搜索树遍历的位运算正确性（中文注释、左0右1、IPv6 128bit 展开）。
- API 只绑 127.0.0.1（D3）。
## 3. 测试口径（先于实现定稿）

### 3.1 契约级

- YAML 解析器：全语法子集表驱动（标量/列表/映射/流式/引号/注释/多级缩进/单行 JSON）+
  错误用例（tab、未闭合流式、锚点报错）；
- socksaddr：编码/解码回环表驱动（ipv4/ipv6/域名）+ 类型字节正确性；
- frame 编解码：全部 cmd 表驱动 + 长度边界（0/65535）+ 半包重组；
- padding scheme：默认 scheme 解析、CheckMark 语义、分包数学（给定随机源确定输出）、
  invalid scheme 拒绝、md5 计算；
- 规则匹配：每类型规则 × 匹配/不匹配表驱动 + no-resolve 语义（IP 规则遇域名跳过）+
  RULE-SET 三种 behavior；
- 配置解析：真实订阅 fixture 全量断言（34 节点、8 组、76 规则、21 providers、端口/模式）。

### 3.2 行为级（会话层/入站/出站）

- 会话层：回显测试（open stream → 写 → 读回）through 测试服务端；SYNACK 超时关会话；
  UpdatePaddingScheme 更新生效；Alert 关闭；认证失败（错密码）服务端关连接；
- 会话池：多流并发复用同会话、流尽回池、空闲清理（fake clock）、Client.Close 全关；
- HTTP 入站：CONNECT 成功/失败(502)、绝对形式转发（request-line 重写、host 头保留）；
- SOCKS5 入站:方法协商、CONNECT 成功/失败 REP、域名 vs IP 请求、UDP 拒绝 0x07、恶意长度
  字段（max 255+65535 边界读不越界）；
- REST API：proxies/rules/connections GET、PUT 切换 select/拒绝非 select、secret 校验、
  401。

### 3.3 e2e（跨进程旅程）

回环全链路：启动测试服务端（AnyTLS over TLS）→ 启动内核（HTTP+SOCKS5 入站，规则将
`example.com:80` 走 anytls 出站）→ 客户端经 HTTP CONNECT + SOCKS5 各发一次请求 → 断言
回显内容与连接台账；再验证 select 切换后流量走另一节点（服务端多实例区分）。

### 3.4 真实节点冒烟（opt-in，非门禁）

`bun test tests/real/ --coverage=false`（环境变量 `REAL_SMOKE=1` 门控）：对订阅拉取 →
挑 3 节点 → AnyTLS 全链路 CONNECT 回显（向节点请求 `tcpbin` 类回显服务不可靠，改为「向
节点请求 http://cp.cloudflare.com/generate 204」并断言 204 + 出口 IP 与本机不同）。
expected count of real smoke: 3 nodes × 2 inbounds.

## 4. 实施顺序（批次计划）

0. 骨架 + 四门脚本（本批）；
1. core（log/clock/types）+ yaml 解析器 + socksaddr + frame + padding（纯函数层）+ 表驱动
   单测；
2. anytls session/client + 测试服务端 + mkcert + 行为级测试；
3. inbound http/socks5 + direct 出站 + 测试；
4. rules + providers + geoip + 配置装配 + 真实订阅 fixture 斋试；
5. api + main + e2e 回环旅程；
6. 真实节点冒烟（opt-in）+ 收口四门 + 对抗审查 + 验收清单。

`bun test` 默认 5s 每用例超时；网络类用例显式放宽并在用例名标注。
## 5. 验收清单

- [ ] CLI 契约（§1.1）逐条：默认配置生成、端口覆盖、--direct、优雅退出、失败退出码
- [ ] HTTP/SOCKS5 契约（§1.2/1.3）逐条
- [ ] AnyTLS 契约（§1.4）逐条：认证/帧/Settings/SYNACK/FIN/Waste/Alert/UpdatePaddingScheme/
      心跳/padding 写路径/会话池
- [ ] 配置契约（§1.5）逐条：顶层键、节点字段、组、规则、providers、YAML 子集、缓存
- [ ] API 壎约（§1.6）：8 端点 × 正常/未认证/参数错
- [ ] e2e 回环全链路绿
- [ ] 四门全绿（check 0 err / lint 0-0 / build 0 err / test 全过）+ 覆盖率数字如实报告
- [ ] 对抗审查问题清零（中级以上必做）
- [ ] 真实节点冒烟（opt-in）3 节点 × 2 入站
- [ ] 文档：README（使用说明）+ 本方案与 test-plan 归档
## 6. 后续（V2 候选）

DNS（fake-ip + DoH + fallback-filter）、UDP over TCP、sniffer、TLS 指纹伪装、更多协议出站
（vmess/trojan/ss）、TUN、API providers 端点与 delay 历史图。

## 7. 实施差异与遗留项（收口时登记）

- **GEOIP data 段解码**：MetaCubeX country.mmdb 的 data 段大量使用指针复用与 extended
  类型，完整 MaxMind decoder 未实现。采用「树遍历 + 叶记录窗口内 0x42+双大写字母」提取
  country code——样本验证 CN 判断精确（CN 叶→CN），非 CN 国家码偶有偏差（如 8.8.8.8 → CZ，
  抓到了 AS 组织注册地而非国家）。对 `GEOIP,CN` 分流语义（CN vs 非 CN）无影响。V2 可换
  完整 decoder。mmdb 树为 IPv6 树，IPv4 查询以 96 位 0 前缀映射（已实现并验证）。
- **metadata 解析**：languages 数组的指针编码与规范读法有出入，node_count/record_size/
  ip_version 用锚点法提取（尾部窗口内键名 + 后随控制字节 uint），已对真实文件验证。
- **rule-providers 启动不阻塞**：21 个规则集并行后台加载（每个 15s 超时），启动即刻可用
  （未加载完成的 RULE-SET 不命中），完成后热替换引擎引用。订阅实测 16MB 规则集全量约 60-90s。
- **AnyTLS client-fingerprint**：节点配置里的 `client-fingerprint: chrome` 被忽略（Bun 用
  BoringSSL 指纹，无 uTLS）。真实节点测试全通，说明当前服务端不校验指纹。
- **测试端口获取**：`Bun.listen` 的返回值端口属性在 `TCPSocketListener.port`。
- **Bun 1.4.3 坑**（对后续维护重要）：
  1. TLS socket 必须在 `open` 回调（握手完成后）写数据，connect resolve 后立刻写会静默丢失；
  2. `Bun.connect` 后用 `socket.reload()` 换 handler 收不到数据——handler 必须在 connect
     options 里给最终形态（闭包引用可变状态）；
  3. `Bun.listen` TLS 需要 RSA 证书（EC 私钥 BoringSSL 解码失败），且 cert/key 传 PEM 字符串
     而非路径；
  4. `crypto.subtle` 不支持 MD5——用 `Bun.CryptoHasher('md5')`；
  5. socket.data handler 赋值给 Bun.Socket 实例属性无效（那是用户 data 槽）。
- **e2e 的 connectViaTunnel**：客户端 socket 的 data handler 必须在 connect options 里一次
  给齐（connect 后再赋值同样收不到数据——与坑 2 同源）。

## 8. 对抗审查处置（收口核销）

独立会话审查交付 15 条（高 3 / 中 6 / 中低 4 / 低 2）。处置：

| # | 严重度 | 问题 | 处置 |
| --- | --- | --- | --- |
| 1 | 高 | 绝对形式 URL 解析未捕获 → unhandledRejection 崩溃 | **已修**：handle 调用点 catch + new URL try/catch → 400 |
| 2 | 高 | probe 超时路径泄漏整个 TLS 会话；writeTarget 抛错泄漏流 | **已修**：probe 的 settled/finish 保证任何路径 close；open 失败关流再抛 |
| 3 | 高 | 流上限死代码（streamCountOf 恒 0）+ 超载分支泄漏 socket | **已修**：流计数移到 session.openedStreams（单一真相）；超载会话直接 close |
| 4 | 中 | HTTP 入站 IPv6 字面目标被当域名（isIpv4 单判） | **已修**：isIpHost = isIpv4 \|\| 含冒号 |
| 5 | 中【存疑】 | padding 覆盖范围与 pkt 计数粒度偏离参考 | **裁决后已修**：对照 anytls-go 源码——控制帧也走 writeConn（padding）；auth 直发不计数；settings+SYN 合并为 pkt1。pkt 以「一次合并写」为单位（参考语义） |
| 6 | 中 | 256KB 流缓冲上限是死代码 | **已修**：onData 超限即断流（清缓冲、拒绝等待者、发 FIN） |
| 7 | 中 | 会话死亡时残余写任务 resolve 成功 → 静默丢数据 | **已修**：WriteJob 带 reject，die 时全部 reject |
| 8 | 中 | API Content-Length 无上界 | **已修**：>64KB → 413 |
| 9 | 中 | SYN deadline 未接线 + 建连无超时 | **部分修**：出站建连 15s 超时（anytls + direct）；SYNACK deadline 的完整语义（连续 2 个在途 SYN 关会话）V1 未接线——流建立失败由上层 502/REP 错误呈现，登记遗留 |
| 10 | 中低 | FIN 后写不报错；REMOTE 错误文本丢失 | **已修**：eof 后 write 抛错；remote: 前缀的 reason 存 err 供读端 |
| 11 | 中低 | 绝对形式 keep-alive 挂死 | **缓解**：读循环 30s 空闲超时；完整 Content-Length 半关闭语义登记遗留 |
| 12 | 中低 | 入站无握手超时 | **已修**：30s 握手超时（隧道建立后清除） |
| 13 | 中低【存疑】 | cmd 10 serverSettings 是否存在 | **驳回**：对照 frame.go/session.go 确认 cmd=10 存在且实现正确 |
| 14 | 低 | bytesOut += 1 应为编码长度 | **已修** |
| 15 | 低【存疑】 | 流式深度>0 时 # 注释/多行流式 | **登记遗留**：当前订阅与主流 rule-provider 形态安全；YAML 子集边界已在 §1.5 声明 |

修复后全量回归：四门全绿、142/142 测试、真实节点冒烟 1/1、全链路（http/socks5 → google/cf 204）通过。
