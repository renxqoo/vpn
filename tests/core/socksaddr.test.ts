import { describe, expect, test } from 'bun:test';
import {
  decodeSocksAddr,
  encodeSocksAddr,
  formatIpv6,
  parseIpv6ToBytes,
  SocksAddrError,
  type SocksAddr,
} from '../../src/core/socksaddr.ts';

function roundtrip(addr: SocksAddr): void {
  const enc = encodeSocksAddr(addr);
  const { addr: back, consumed } = decodeSocksAddr(enc);
  expect(consumed).toBe(enc.length);
  expect(back).toEqual(addr);
}

describe('socksaddr roundtrip', () => {
  test('ipv4', () => {
    roundtrip({ type: 'ipv4', host: '1.2.3.4', port: 443 });
    roundtrip({ type: 'ipv4', host: '127.0.0.1', port: 0 });
    roundtrip({ type: 'ipv4', host: '255.255.255.255', port: 65535 });
  });
  test('fqdn', () => {
    roundtrip({ type: 'fqdn', host: 'example.com', port: 80 });
    roundtrip({ type: 'fqdn', host: 'a'.repeat(255), port: 1 });
    roundtrip({ type: 'fqdn', host: '中文域名.cn', port: 80 });
  });
  test('ipv6 full / compressed / v4-mapped', () => {
    roundtrip({ type: 'ipv6', host: '2001:db8::1', port: 443 });
    roundtrip({ type: 'ipv6', host: '::1', port: 443 });
    roundtrip({ type: 'ipv6', host: '::', port: 443 });
    roundtrip({ type: 'ipv6', host: '64:ff9b::1.2.3.4', port: 443 });
    roundtrip({ type: 'ipv6', host: 'fe80::', port: 443 });
  });
});

describe('socksaddr wire format', () => {
  test('ipv4 bytes exact', () => {
    const enc = encodeSocksAddr({ type: 'ipv4', host: '10.0.0.1', port: 8080 });
    expect(Array.from(enc)).toEqual([0x01, 10, 0, 0, 1, 0x1f, 0x90]);
  });
  test('fqdn bytes exact', () => {
    const enc = encodeSocksAddr({ type: 'fqdn', host: 'ab', port: 1 });
    expect(Array.from(enc)).toEqual([0x03, 2, 97, 98, 0, 1]);
  });
  test('ipv6 bytes exact for ::1', () => {
    const enc = encodeSocksAddr({ type: 'ipv6', host: '::1', port: 2 });
    const expected = [0x04, ...new Array(15).fill(0), 1, 0, 2];
    expect(Array.from(enc)).toEqual(expected);
  });
});

describe('socksaddr decode errors', () => {
  test('missing atyp', () => {
    expect(() => decodeSocksAddr(new Uint8Array(0))).toThrow(SocksAddrError);
  });
  test('truncated fqdn', () => {
    const enc = encodeSocksAddr({ type: 'fqdn', host: 'abcd', port: 1 });
    expect(() => decodeSocksAddr(enc.subarray(0, 5))).toThrow(SocksAddrError);
  });
  test('fqdn length 0', () => {
    expect(() => decodeSocksAddr(new Uint8Array([0x03, 0, 0, 1]))).toThrow(SocksAddrError);
  });
  test('unknown atyp', () => {
    expect(() => decodeSocksAddr(new Uint8Array([0x99, 1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(SocksAddrError);
  });
});

describe('ipv6 helpers', () => {
  test('parseIpv6ToBytes correctness', () => {
    expect(Array.from(parseIpv6ToBytes('::') ?? [])).toEqual(new Array(16).fill(0));
    expect(Array.from(parseIpv6ToBytes('2001:db8::1') ?? []).slice(0, 6)).toEqual([0x20, 0x01, 0x0d, 0xb8, 0, 0]);
    expect(parseIpv6ToBytes('1::2::3')).toBeNull();
    expect(parseIpv6ToBytes('::ffff:1.2.3.4')?.[15]).toBe(4);
    expect(parseIpv6ToBytes('gg::1')).toBeNull();
  });
  test('formatIpv6 compresses longest zero run', () => {
    expect(formatIpv6('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(formatIpv6('0:0:0:0:0:0:0:1')).toBe('::1');
  });
});
