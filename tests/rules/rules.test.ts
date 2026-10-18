import { describe, expect, test } from 'bun:test';
import { LAN_CIDRS, parseRuleLine } from '../../src/config/clash.ts';
import { matchCidr, matchDomainSet, RuleEngine } from '../../src/rules/index.ts';
import { parseProviderPayload } from '../../src/rules/providers.ts';
import type { RouteContext } from '../../src/core/types.ts';
import type { DomainSet } from '../../src/rules/index.ts';

function ctx(host: string, port = 443): RouteContext {
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
  return { host, port, isIp };
}

const domainPayload = `payload:
  - '+.google.com'
  - 'youtube.com'
  - '+.ytimg.com'
`;

const ipcidrPayload = `payload:
  - '91.108.4.0/22'
  - '2001:b28:f23d::/48'
`;

const classicalPayload = `payload:
  - DOMAIN-SUFFIX,openai.com
  - IP-CIDR,1.2.3.4/32
`;

describe('rule engine', () => {
  const providers = new Map([
    ['dom', { resolved: parseProviderPayload(domainPayload, 'domain') }],
    ['cidr', { resolved: parseProviderPayload(ipcidrPayload, 'ipcidr') }],
    ['cls', { resolved: parseProviderPayload(classicalPayload, 'classical') }],
  ]);

  const engine = new RuleEngine({
    rules: [
      parseRuleLine('DOMAIN,exact.com,PROXY'),
      parseRuleLine('DOMAIN-SUFFIX,baidu.com,DIRECT'),
      parseRuleLine('DOMAIN-KEYWORD,paofu,PROXY'),
      parseRuleLine('IP-CIDR,10.0.0.0/8,DIRECT'),
      parseRuleLine('IP-CIDR6,fe80::/10,DIRECT'),
      parseRuleLine('GEOIP,LAN,DIRECT,no-resolve'),
      parseRuleLine('RULE-SET,dom,PROXY'),
      parseRuleLine('RULE-SET,cidr,PROXY'),
      parseRuleLine('RULE-SET,cls,PROXY'),
      parseRuleLine('DOMAIN-SUFFIX,ads.com,REJECT'),
      parseRuleLine('MATCH,FINAL'),
    ],
    providers,
    geoip: null,
    final: 'DIRECT',
  });

  test('DOMAIN exact match (case-insensitive, trailing dot)', () => {
    expect(engine.resolve(ctx('exact.com'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('EXACT.COM'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('exact.com.'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('sub.exact.com'))).toEqual({ outbound: 'FINAL' });
  });

  test('DOMAIN-SUFFIX matches bare and subdomains, rejects lookalikes', () => {
    expect(engine.resolve(ctx('baidu.com'))).toEqual({ outbound: 'DIRECT' });
    expect(engine.resolve(ctx('www.baidu.com'))).toEqual({ outbound: 'DIRECT' });
    expect(engine.resolve(ctx('xbaidu.com'))).toEqual({ outbound: 'FINAL' });
    expect(engine.resolve(ctx('notbaidu.com.evil.io'))).toEqual({ outbound: 'FINAL' });
  });

  test('DOMAIN-KEYWORD substring', () => {
    expect(engine.resolve(ctx('paofucloud.com'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('xpaofux.io'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('example.com'))).not.toEqual({ outbound: 'PROXY' });
  });

  test('IP-CIDR matches within family, skips domains', () => {
    expect(engine.resolve(ctx('10.1.2.3'))).toEqual({ outbound: 'DIRECT' });
    expect(engine.resolve(ctx('11.0.0.1'))).toEqual({ outbound: 'FINAL' });
    expect(engine.resolve(ctx('example.com'))).toEqual({ outbound: 'FINAL' }); // IP 规则遇域名跳过
  });

  test('IP-CIDR6', () => {
    expect(engine.resolve(ctx('fe80::1'))).toEqual({ outbound: 'DIRECT' });
    expect(engine.resolve(ctx('2001:db8::1'))).toEqual({ outbound: 'FINAL' });
  });

  test('GEOIP LAN via builtin private ranges', () => {
    expect(engine.resolve(ctx('192.168.1.1'))).toEqual({ outbound: 'DIRECT' });
    expect(engine.resolve(ctx('8.8.8.8'))).toEqual({ outbound: 'FINAL' });
  });

  test('RULE-SET domain behavior', () => {
    expect(engine.resolve(ctx('www.google.com'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('youtube.com'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('i.ytimg.com'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('notgoogle.com'))).toEqual({ outbound: 'FINAL' });
  });

  test('RULE-SET ipcidr behavior', () => {
    expect(engine.resolve(ctx('91.108.5.1'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('91.109.0.1'))).toEqual({ outbound: 'FINAL' });
    expect(engine.resolve(ctx('2001:b28:f23d:5::9'))).toEqual({ outbound: 'PROXY' });
  });

  test('RULE-SET classical behavior', () => {
    expect(engine.resolve(ctx('api.openai.com'))).toEqual({ outbound: 'PROXY' });
    expect(engine.resolve(ctx('1.2.3.4'))).toEqual({ outbound: 'PROXY' });
  });

  test('REJECT target yields reject decision', () => {
    expect(engine.resolve(ctx('ads.com'))).toEqual({ reject: true });
  });

  test('MATCH fallback', () => {
    expect(engine.resolve(ctx('unknown.io'))).toEqual({ outbound: 'FINAL' });
  });

  test('order matters: first hit wins', () => {
    const e2 = new RuleEngine({
      rules: [
        parseRuleLine('DOMAIN-SUFFIX,x.com,REJECT'),
        parseRuleLine('DOMAIN,a.x.com,DIRECT'),
        parseRuleLine('MATCH,DIRECT'),
      ],
      providers: new Map(),
      geoip: null,
      final: 'DIRECT',
    });
    expect(e2.resolve(ctx('a.x.com'))).toEqual({ reject: true });
  });
});

describe('cidr matcher', () => {
  test('v4 exact and boundary', () => {
    expect(matchCidr('10.0.0.0', '10.0.0.0/8')).toBe(true);
    expect(matchCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(matchCidr('11.0.0.0', '10.0.0.0/8')).toBe(false);
    expect(matchCidr('192.168.1.1', '192.168.0.0/16')).toBe(true);
    expect(matchCidr('192.169.1.1', '192.168.0.0/16')).toBe(false);
  });
  test('v6', () => {
    expect(matchCidr('fe80::1', 'fe80::/10')).toBe(true);
    expect(matchCidr('ffff::1', 'fe80::/10')).toBe(false);
    expect(matchCidr('64:ff9b::1.2.3.4', '64:ff9b::/96')).toBe(true);
  });
});

describe('provider payload parsing', () => {
  test('plain text (no payload: header) auto-detected', () => {
    const r = parseProviderPayload('+.a.com\nb.net\n', 'domain');
    if (!r.domains) throw new Error('domains');
    expect(r.domains.suffixes.has('a.com')).toBe(true);
    expect(r.domains.exact.has('b.net')).toBe(true);
  });
  test('ipcidr text skips comments and bad lines', () => {
    const r = parseProviderPayload('# comment\n0.0.0.0/8\nnot-a-cidr\n', 'ipcidr');
    expect(r.cidrs?.length).toBe(1);
  });
});

describe('domain set matching', () => {
  test('multi-label suffix strip', () => {
    const set: DomainSet = { suffixes: new Set(['co.uk']), exact: new Set(), keywords: new Set() };
    expect(matchDomainSet(set, 'bbc.co.uk')).toBe(true);
    expect(matchDomainSet(set, 'a.b.c.co.uk')).toBe(true);
    expect(matchDomainSet(set, 'couk')).toBe(false);
  });
});

void LAN_CIDRS;
