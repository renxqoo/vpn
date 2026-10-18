# 测试计划（先于实现定稿）

配套 `docs/design.md`。原则（feature-dev-v2 §3）：契约级表驱动优先、边界与异常全覆盖、
每个开发期 bug 补回归用例、e2e 断言业务终态而非 200。

## 1. 单元（表驱动，每个模块一个 test 文件）

### yaml.test.ts
- 标量：int/float/bool(true/false/True)/null(~/null)/字符串裸/单引号(转义''→')/双引号
  (\\n 转义)/含 # 的引号字符串/日期不识别(当字符串)/空值；
- 嵌套：映射/序列/混合/多级缩进/流式 [] {}/单行 JSON 整对象（订阅 proxies 形态）/流式
  嵌套引号/负数/端口大数；
- 错误：tab 缩进、未闭合流式、锚点&x、块标量|、重复键（报错）、值后多余 token；
- 位置：错误信息带 行:列；
- 回环：parse(stringify?) 不要求（不做 stringify）。

### socksaddr.test.ts
- encode/decode 回环：ipv4、ipv6（含 ::1、::、full）、fqdn 短/长（255）、port 0/65535；
- 类型字节：0x01/0x03/0x04 正确性；畸形（域长 0、port 截断、未知类型）报错。

### frame.test.ts
- 全部 11 个 cmd 编码字节精确断言（金标准数组）；
- decode：半包（3/5/6 字节）、多帧粘包、len=0、len=65535、垃圾 cmd（>10 忽略语义：解析层
  报 unknown cmd 由会话层决定）；
- 编码长度断言 = 7+n。

### padding.test.ts
- 默认 scheme 解析：stop=8、pkt0=30-30、pkt2 序列 5 项含 4 个 c；
- GenerateRecordPayloadSizes：注入固定随机源 → 确定性输出；min=max 直接返回；min>max 交换；
  无定义 pkt → 空数组；invalid（缺 stop、0=行、负数、垃圾 token 跳过）→ null；
- md5：对默认 scheme 的 md5 与 Go 参考一致（预计算金标准）；
- writeConn 分包数学（纯函数 extractChunkPlan）：给定 scheme/pkt/待写字节数 → 精确的
  [payloadLen|wasteLen] 序列断言（含 CheckMark 提前停止、补 7 字节头的 waste、全 payload、
  全 waste、剩余直发）。

### rules.test.ts
- 每类型规则匹配表：DOMAIN（精确/大小写/尾点）、DOMAIN-SUFFIX（含子域/裸域/大小写/非后缀
  拒绝——`baidu.com` 不匹配 `ibaidu.com`）、DOMAIN-KEYWORD（包含）、IP-CIDR（含/边界/拒
  绝非同族）、IP-CIDR6、GEOIP(CN/LAN)（对拍 mmdb：预置 1.2.4.8=CN、8.8.8.8=US，LAN 用
  内置私网段）、RULE-SET domain/ipcidr/classical 三 behavior、MATCH、no-resolve 语义
  （IP 规则遇 host 为域名且 no-resolve → 跳过该规则）；
- 规则链顺序：首中即出；都不中 → undefined（配置层保证 MATCH 兜底）。

### clash-config.test.ts
- 真实订阅 fixture：34 节点（第一个/最后一个字段精确断言）、8 组、76 规则、21 providers、
  port=7890 socks-port=7891 mode=rule、geox-url.geoip 提取；
- 未知节点 type → unavailable 标记 + 警告；未知顶层键警告；dns/sniffer/tun 警告忽略；
- rules 里引用不存在的组/节点 → 报错退出；proxy-groups 引用不存在成员 → 报错；
- 订阅 URL 带查询串保留。

### providers.test.ts
- 三 behavior 的 payload 解析（domain: +.a.com 形态、ipcidr、classical 三段）；
- txt 与 yaml 格式自动识别（payload: 头存在与否）；
- 缓存读写（.cache 目录注入临时目录）；interval 到期判定（fake clock）。

### geoip.test.ts
- mmdb 二进制解析（用自造的最小 mmdb fixture——手写 tree builder 造 1.2.4.8→CN）：搜索
  正确性、IPv4-mapped IPv6、不存在 → country null；
- 下载失败 → GEOIP 规则禁用警告（注入 fetch 替身）。

### session.test.ts（会话层，配测试服务端）
- 回显：open → write → read 全流程；
- SYNACK 错误（服务端主动下发带 data 的 SYNACK）→ 流收到错误关闭；
- FIN 语义：对端 FIN → 本端读 EOF；本端 close → 对端收到 FIN；
- Waste 丢弃；Alert → 会话关闭；认证失败（错密码）→ 连接被服务端关闭；
- UpdatePaddingScheme 收到后：后续会话用新 scheme（可观测：pkt 尺寸分布变化/内部状态断言）；
- 心跳：服务端 HeartRequest → 客户端回 HeartResponse；
- v1 服务端（不下发 ServerSettings）→ 客户端不启用 SYNACK 期待、不因 SYNACK 超时关会话。

### client-pool.test.ts
- 多流并发 → 复用同一会话（会话数=1）；会话死 → 新建；流尽回池（seq 最大优先取）；
  idleCleanup（fake clock）：超时且超 minIdle → 关；保留 minIdle；Client.Close 全关；
  disableReuse 语义（V1 默认启用复用）。

### inbound-http.test.ts
- CONNECT 成功 → 200；上游不可达 → 502；规则拒绝 → 403；
- 绝对形式：request-line 重写、Host 头保留、响应逐字节转发；
- 头部超 256KB → 断开。

### inbound-socks5.test.ts
- 协商：no-auth 成功、仅 method 5 → ffffffff 拒绝；
- CONNECT 域名/IP 各成功一次；上游不可达 REP=0x05（此处 V1 用 0x01 general failure）；
  UDP → 0x07；
- 恶意流：atyp=0x99 → REP=0x01 + 关闭；domLen=0；截断头（等待不崩溃，超时断开）。

### api.test.ts
- GET /proxies /proxies/:name /rules /connections /version；
- PUT /proxies/:name select 切换生效（再 GET 断言 now 变化）；url-test 组 PUT → 400；
  不存在 → 404；无 secret 配置时匿名可访问；
- secret 配置时：无/错 Authorization → 401，正确 Bearer → 200；
- DELETE /connections/:id → 连接关闭 + 台账移除；不存在 id → 404。

## 2. e2e（tests/e2e/）

`e2e.journeys.test.ts`：
1. 起 AnyTLS 测试服务端 A/B（两实例，回显 + 记录来访目标）；
2. 起内核（注入配置：http/socks 入站、规则 example.org→节点A、其余→MATCH 节点B）；
3. HTTP CONNECT 到 A 规则目标 → 断言回显 + 服务端 A 记录的目标 = 预期域名:端口；
4. SOCKS5 CONNECT 到非 A 规则目标 → 走 B（服务端 B 记录验证）；
5. API PUT 切换 select 组 → 新连接走 B → 断言流量切换生效；
6. 台账：连接出现/消失、chains 字段正确；
7. 全程 stderr 无 ERROR 级日志。

## 3. 真实节点冒烟（tests/real/smoke.test.ts，opt-in）

- 门控 `REAL_SMOKE=1`，未设置时 `test.skip`（bun 的 test.skip 动态：用 process.env 判断
  → it.skip）；
- 拉订阅（线上，失败则 fail——real 门不 fallback）；
- 取前 3 个不同地区节点，各：AnyTLS 开流 → 写 SOCKSAddr(tcpbin 不可靠，用
  `http://cp.cloudflare.com` 的 SOCKSAddr + 手写 HTTP/1.0 GET) → 读响应 → 断言含
  `204`/HTTP 头；出口 IP ≠ 本机出口（用同一链路请求 ifconfig.me 对比）；
- 每节点超时 15s；失败输出节点名与阶段。

## 4. 门禁与数字

- `bun check`：0 错误；
- `bun run lint`：0 警告 0 错误（自研 lint：禁止 any/except 裸 catch（须注释理由标记）/
  console.*（除 tools 与 main 出口）/ TODO/FIXME 未挂 issue/超长行>120；
- `bun run build`：build 成功（bun build src/main.ts --target=bun）；
- `bun test`：全过（网络用例显式 timeout；real 门默认 skip）；
- `bun test --coverage`：数字如实报告（不设阈值，D7c）。

`tests/` 目录镜像 `src/` 布局。
## 5. 回归用例登记处

开发中发现的 bug（症状 → 覆盖位置）：
- DirectConn.read 引用未定义变量 → inbound 回显测试（http/socks5 echo）
- 测试客户端 socket 双队列竞态（waiters/chunks 重复消费）→ connectRaw 修复后由全部入站测试覆盖
- CIDR v4 前缀位比较错位（128 位空间含主机位）→ cidr matcher v4/v6 边界用例
- providers classical 解析对 2 段条目生成 MATCH（匹配一切）→ classical payload variants
- YAML 块序列项的流式映射值（订阅 proxies 单行 JSON）→ yaml structures 用例
- API Content-Length 用字符长度（中文 payload 截断）→ rules endpoint e2e
- API Bearer 前缀未剥离 → secret enforced 用例
- 对抗审查修复（见 design.md §8）：崩溃/泄漏/静默丢数据等 12 项——由既有 142 个用例回归
