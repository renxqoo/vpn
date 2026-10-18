import { describe, expect, test } from 'bun:test';
import {
  type YamlValue,
  asMap,
  asSeq,
  asStr,
  parseYaml,
  YamlError,
} from '../../src/config/yaml.ts';

describe('yaml scalars', () => {
  test('int / float / hex', () => {
    const m = asMap(parseYaml('a: 1\nb: -2\nc: 3.5\nd: 0x10'), 'root');
    expect(m['a'] as YamlValue).toBe(1);
    expect(m['b'] as YamlValue).toBe(-2);
    expect(m['c'] as YamlValue).toBe(3.5);
    expect(m['d'] as YamlValue).toBe(16);
  });
  test('bool variants & null', () => {
    const m = asMap(parseYaml('a: true\nb: False\nc: ~\nd: null'), 'root');
    expect(m['a'] as YamlValue).toBe(true);
    expect(m['b'] as YamlValue).toBe(false);
    expect(m['c'] as YamlValue).toBeNull();
    expect(m['d'] as YamlValue).toBeNull();
  });
  test('bare string with spaces and CJK', () => {
    const m = asMap(parseYaml('name: 台湾 01'), 'root');
    expect(m['name']).toBe('台湾 01');
  });
  test('single quote escape', () => {
    const m = asMap(parseYaml("v: 'it''s'"), 'root');
    expect(m['v'] as YamlValue).toBe("it's");
  });
  test('double quote escapes', () => {
    const m = asMap(parseYaml('v: "a\\nb\\tc\\u4e2d"'), 'root');
    expect(m['v'] as YamlValue).toBe('a\nb\tc中');
  });
  test('hash inside quotes is not comment', () => {
    const m = asMap(parseYaml("v: 'a # b' # real comment"), 'root');
    expect(m['v'] as YamlValue).toBe('a # b');
  });
  test('hash inside bare scalar without preceding space stays', () => {
    const m = asMap(parseYaml('v: a#b'), 'root');
    expect(m['v'] as YamlValue).toBe('a#b');
  });
  test('emoji key and value', () => {
    const m = asMap(parseYaml('🚀 节点选择: x'), 'root');
    expect(Object.keys(m)).toEqual(['🚀 节点选择']);
    expect(m['🚀 节点选择']).toBe('x');
  });
  test('port as number, big number string fallback', () => {
    const m = asMap(parseYaml('port: 7890\nbig: 12345678901234567890'), 'root');
    expect(m['port']).toBe(7890);
    expect(m['big']).toBe('12345678901234567890');
  });
});

describe('yaml structures', () => {
  test('nested map + seq', () => {
    const v = parseYaml(`
a:
  - 1
  - 2
b:
  c:
    d: e
`);
    const m = asMap(v, 'root');
    expect(asSeq(m['a'] as YamlValue, 'a')).toEqual([1, 2]);
    expect(asMap(asMap(m['b'] as YamlValue, 'b')['c'] as YamlValue, 'c')['d']).toBe('e');
  });
  test('flow seq and map', () => {
    const m = asMap(parseYaml("a: [80, 443, '8080-8880']\nb: {x: 1, y: 'z'}"), 'root');
    expect(asSeq(m['a'] as YamlValue, 'a')).toEqual([80, 443, '8080-8880']);
    const b = asMap(m['b'] as YamlValue, 'b');
    expect(b['x']).toBe(1);
    expect(b['y']).toBe('z');
  });
  test('single-line JSON object (subscription proxies form)', () => {
    const m = asMap(
      parseYaml(`proxies:
  - {"name":"香港 01","type":"anytls","server":"synth.example.net","port":37211,"udp":true,"skip-cert-verify":true}`),
      'root',
    );
    const proxies = asSeq(m['proxies'] as YamlValue, 'proxies');
    const p0 = asMap(proxies[0] as YamlValue, 'proxies[0]');
    expect(p0['name']).toBe('香港 01');
    expect(p0['port']).toBe(37211);
    expect(p0['udp']).toBe(true);
    expect(p0['skip-cert-verify']).toBe(true);
    expect(p0['client-fingerprint']).toBeUndefined();
  });
  test('seq of quoted strings with mixed quotes', () => {
    const m = asMap(parseYaml("l:\n  - '+.a.com'\n  - \"b.net\"\n  - plain"), 'root');
    expect(asSeq(m['l'] as YamlValue, 'l')).toEqual(['+.a.com', 'b.net', 'plain']);
  });
  test('seq item dash at same indent as parent key', () => {
    const m = asMap(
      parseYaml(`proxies:
-
  name: a
  type: select
`),
      'root',
    );
    const g = asMap(asSeq(m['proxies'] as YamlValue, 'proxies')[0] as YamlValue as YamlValue, 'proxies[0]');
    expect(g['name']).toBe('a');
    expect(g['type']).toBe('select');
  });
  test('--- document start tolerated', () => {
    const m = asMap(parseYaml('---\na: 1'), 'root');
    expect(m['a'] as YamlValue).toBe(1);
  });
  test('comments and blank lines ignored', () => {
    const m = asMap(parseYaml('# top\n\na: 1 # trailing\n\n# mid\nb: 2\n'), 'root');
    expect(m['a'] as YamlValue).toBe(1);
    expect(m['b'] as YamlValue).toBe(2);
  });
  test('comment-only file yields null', () => {
    expect(parseYaml('# nothing\n\n')).toBeNull();
  });
  test('value map on next line (subscription proxy-groups form)', () => {
    const m = asMap(
      parseYaml(`proxy-groups:
-
  name: '🚀 节点选择'
  type: select
  proxies:
    - '♻️ 自动选择'
    - '香港 01'
`),
      'root',
    );
    const groups = asSeq(m['proxy-groups'] as YamlValue, 'groups');
    const g = asMap(groups[0] as YamlValue, 'g0');
    expect(asStr(g['name'] as YamlValue, 'name')).toBe('🚀 节点选择');
    expect(asSeq(g['proxies'] as YamlValue, 'proxies')).toEqual(['♻️ 自动选择', '香港 01']);
  });
});

describe('yaml errors', () => {
  test('tab indentation', () => {
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(YamlError);
  });
  test('anchor rejected', () => {
    expect(() => parseYaml('a: &anchor 1')).toThrow(YamlError);
  });
  test('alias rejected', () => {
    expect(() => parseYaml('a: *x')).toThrow(YamlError);
  });
  test('block scalar rejected', () => {
    expect(() => parseYaml('a: |\n  text')).toThrow(YamlError);
  });
  test('unterminated flow map', () => {
    expect(() => parseYaml('a: {x: 1')).toThrow(YamlError);
  });
  test('duplicate key', () => {
    expect(() => parseYaml('a: 1\na: 2')).toThrow(YamlError);
  });
  test('multiple documents', () => {
    expect(() => parseYaml('a: 1\n---\nb: 2')).toThrow(YamlError);
  });
  test('error carries line number', () => {
    try {
      parseYaml('a: 1\n\n\tbad: 1');
      expect.unreachable();
    } catch (e) {
      expect((e as YamlError).line).toBe(3);
    }
  });
});
