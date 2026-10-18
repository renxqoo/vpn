/** 默认配置模板（家目录 ~/.vpn/config.yaml 首次生成用） */

const SUB_LINE = ''; // 空订阅：首启引导用户写入
export const DEFAULT_CONFIG_YAML = [
  '# bun-clash 配置（正式配置；dev 调试用项目根 .env 的 SUBSCRIPTION_URL）',
  '# 写入订阅：bun run config set-subscription <你的订阅地址>',
  `subscription-url: '${SUB_LINE}'`,
  'port: 7890',
  'socks-port: 7891',
  'mode: rule',
  'log-level: info',
  "external-controller: '127.0.0.1:9090'",
  "secret: ''",
  'rules:',
  '  - MATCH,DIRECT',
  '',
].join('\n');
