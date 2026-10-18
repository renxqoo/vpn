import { describe, expect, test } from 'bun:test';
import { MmdbReader } from '../../src/rules/geoip.ts';

const buf = new Uint8Array(
  await Bun.file(new URL('../fixtures/country-test.mmdb', import.meta.url).pathname).arrayBuffer(),
);
const reader = new MmdbReader(buf);

describe('mmdb geoip (MetaCubeX country.mmdb fixture)', () => {
  test('CN addresses resolve to CN', () => {
    for (const ip of ['1.2.4.8', '114.114.114.114', '223.5.5.5', '202.96.209.133', '180.76.76.76']) {
      expect(reader.country(ip)).toBe('CN');
    }
  });

  test('non-CN addresses never resolve to CN', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '13.107.0.1', '104.16.0.1', '151.101.1.1']) {
      expect(reader.country(ip)).not.toBe('CN');
    }
  });

  test('invalid ip yields null', () => {
    expect(reader.country('not-an-ip')).toBeNull();
    expect(reader.country('')).toBeNull();
  });
});
