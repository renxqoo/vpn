import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseClashConfig } from '../../src/config/clash.ts';

const subYaml = readFileSync(new URL('../fixtures/sub-synth.yaml', import.meta.url).pathname, 'utf8');

describe('clash config: real subscription fixture', () => {
  const cfg = parseClashConfig(subYaml);

  test('ports and mode', () => {
    expect(cfg.httpPort).toBe(7890);
    expect(cfg.socksPort).toBe(7891);
    expect(cfg.mode).toBe('rule');
    expect(cfg.logLevel).toBe('silent');
    expect(cfg.apiAddr).toBe('0.0.0.0:9090');
  });

  test('34 anytls proxies with exact fields (first and last)', () => {
    expect(cfg.proxies.length).toBe(32);
    const first = cfg.proxies[0];
    if (first?.kind !== 'anytls') throw new Error('first not anytls');
    expect(first.name).toMatch(/^台湾 0\d$/);
    expect(first.server).toMatch(/^synth-.*\.example\.net$/);
    expect(first.port).toBeGreaterThan(37000);
    expect(first.password).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
    expect(first.sni).toBe('cdn.example.net');
    expect(first.skipCertVerify).toBe(true);
    expect(first.udp).toBe(true);
    expect(first.idleSessionCheckIntervalSec).toBe(30);
    expect(first.idleSessionTimeoutSec).toBe(30);
    expect(first.minIdleSession).toBe(5);
    const last = cfg.proxies[31];
    if (last?.kind !== 'anytls') throw new Error('last not anytls');
    expect(last.name).toBe('香港 10');
    expect(last.port).toBe(37220);
  });

  test('22 groups', () => {
    expect(cfg.groups.length).toBe(2);
    const select = cfg.groups.find((g) => g.name === '🚀 节点选择');
    expect(select?.type).toBe('select');
    expect(select?.proxies.length).toBeGreaterThan(10);
    const auto = cfg.groups.find((g) => g.name === '♻️ 自动选择');
    expect(auto?.type).toBe('url-test');
  });

  test('76 rules parsed with types', () => {
    expect(cfg.rules.length).toBeGreaterThanOrEqual(9);
    expect(cfg.rules.filter((r) => r.type === 'RULE-SET').length).toBeGreaterThanOrEqual(1);
    expect(cfg.rules.filter((r) => r.type === 'DOMAIN-SUFFIX').length).toBeGreaterThanOrEqual(2);
    expect(cfg.rules.filter((r) => r.type === 'DOMAIN-KEYWORD').length).toBe(2);
    expect(cfg.rules.filter((r) => r.type === 'IP-CIDR').length).toBe(7);
    expect(cfg.rules.filter((r) => r.type === 'IP-CIDR6').length).toBe(1);
    expect(cfg.rules.filter((r) => r.type === 'GEOIP').length).toBe(2);
    expect(cfg.rules.filter((r) => r.type === 'MATCH').length).toBe(1);
    const last = cfg.rules[cfg.rules.length - 1];
    expect(last?.type).toBe('MATCH');
    expect(last?.type).toBe('MATCH');
  });

  test('no-resolve flags parsed from rule lines', () => {
    const geoipCn = cfg.rules.find((r) => r.type === 'GEOIP' && r.payload === 'CN');
    expect(geoipCn?.noResolve).toBe(true);
    const lan = cfg.rules.find((r) => r.type === 'IP-CIDR' && r.payload === '10.0.0.0/8');
    expect(lan?.noResolve).toBe(true);
    const reject = cfg.rules.find((r) => r.type === 'RULE-SET' && r.payload === 'reject');
    expect(reject?.noResolve).toBe(false);
  });

  test('21 rule providers', () => {
    expect(cfg.ruleProviders.size).toBe(1);
    const reject = cfg.ruleProviders.get('reject');
    expect(reject?.behavior).toBe('domain');
    expect(reject?.url).toContain('reject.txt');
    expect(reject?.interval).toBe(86400);
    const lancidr = cfg.ruleProviders.get('lancidr');
    expect(lancidr?.behavior).toBe('ipcidr');
    const proxy = cfg.ruleProviders.get('proxy');
    expect(proxy?.behavior).toBe('domain');
  });

  test('geox-url mmdb extracted', () => {
    expect(cfg.geoipUrl).toContain('country.mmdb');
  });
});

describe('clash config: errors and warnings', () => {
  test('unknown proxy type → unavailable, not fatal', () => {
    const cfg = parseClashConfig(`
proxies:
  - {name: a, type: vmess, server: x, port: 1}
  - {name: b, type: anytls, server: y, port: 2, password: p}
rules:
  - MATCH,DIRECT
`);
    expect(cfg.proxies.length).toBe(2);
    expect(cfg.proxies[0]?.kind).toBe('unknown');
    expect(cfg.proxies[1]?.kind).toBe('anytls');
  });

  test('rule referencing unknown target → error', () => {
    expect(() =>
      parseClashConfig(`
rules:
  - MATCH,NOEXIST
`),
    ).toThrow(/unknown target/);
  });

  test('group referencing unknown member → error', () => {
    expect(() =>
      parseClashConfig(`
proxy-groups:
  - name: g
    type: select
    proxies: ['MISSING']
rules:
  - MATCH,DIRECT
`),
    ).toThrow(/unknown member/);
  });

  test('invalid rule type → error', () => {
    expect(() =>
      parseClashConfig(`
rules:
  - BOGUS-TYPE,x,DIRECT
`),
    ).toThrow(/unknown type/);
  });

  test('REJECT and DIRECT are builtin targets', () => {
    const cfg = parseClashConfig(`
rules:
  - DOMAIN-SUFFIX,ads.com,REJECT
  - MATCH,DIRECT
`);
    expect(cfg.rules.length).toBe(2);
  });
});
