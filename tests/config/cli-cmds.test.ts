import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  groupByRegion,
  listSelectableNodes,
  readSelectedNode,
  regionOf,
  writeSelectedNode,
} from '../../src/config/nodes.ts';
import { parseUserinfo, renderUsage, formatBytes } from '../../src/config/usage.ts';
import { readMode, writeMode } from '../../src/config/mode.ts';

function anytls(name: string, server: string, port: number) {
  return {
    kind: 'anytls', name, server, port, password: 'p', skipCertVerify: false, udp: false,
    idleSessionCheckIntervalSec: 30, idleSessionTimeoutSec: 30, minIdleSession: 5,
  };
}

const realHome = process.env.HOME as string;
const realProfile = process.env.USERPROFILE as string | undefined;
const tmpHome = mkdtempSync(join(tmpdir(), 'vpn-cli-'));

beforeAll(() => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  if (realProfile !== undefined) process.env.USERPROFILE = realProfile;
  else delete process.env.USERPROFILE;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('nodes command units', () => {
  test('regionOf extracts region prefix', () => {
    expect(regionOf('台湾 01')).toBe('台湾');
    expect(regionOf('美国 06 (家宽)')).toBe('美国');
    expect(regionOf('香港 10')).toBe('香港');
  });

  test('listSelectableNodes filters anytls and groups by region', () => {
    const proxies = [
      anytls('台湾 01', 'a', 1),
      anytls('台湾 02', 'a', 2),
      anytls('德国 01', 'b', 3),
      { kind: 'unknown', name: 'x', type: 'vmess' },
    ] as never[];
    const nodes = listSelectableNodes(proxies);
    expect(nodes.length).toBe(3);
    const groups = groupByRegion(nodes);
    expect(groups.get('台湾')?.length).toBe(2);
    expect(groups.get('德国')?.length).toBe(1);
  });

  test('writeSelectedNode persists and readSelectedNode reads back', async () => {
    {
      const path = await writeSelectedNode('台湾 01');
      expect(existsSync(path)).toBe(true);
      expect(await readSelectedNode()).toBe('台湾 01');
      await writeSelectedNode('美国 06');
      expect(await readSelectedNode()).toBe('美国 06');
      const text = readFileSync(path, 'utf8');
      expect(text.match(/^selected-node:/gm)?.length).toBe(1);
      await writeSelectedNode(null);
      expect(await readSelectedNode()).toBeNull();
    }
  });

  test('node name with single quote is escaped', async () => {
    await writeSelectedNode("x'y");
    expect(await readSelectedNode()).toBe("x'y");
  });
});

describe('usage rendering', () => {
  test('parseUserinfo handles full header', () => {
    const u = parseUserinfo('upload=100; download=400; total=1000; expire=1800000000');
    expect(u).toEqual({ upload: 100, download: 400, total: 1000, expire: 1800000000 });
  });
  test('parseUserinfo rejects missing/garbage', () => {
    expect(parseUserinfo(null)).toBeNull();
    expect(parseUserinfo('upload=1')).toBeNull();
    expect(parseUserinfo('upload=x; download=2')).toBeNull();
  });
  test('renderUsage shows percent, remain, expiry', () => {
    const lines = renderUsage({ upload: 25, download: 25, total: 100, expire: null });
    expect(lines.some((l) => l.includes('50.0%'))).toBe(true);
    expect(lines.some((l) => l.includes('剩余'))).toBe(true);
    expect(lines.some((l) => l.includes('未提供到期时间'))).toBe(true);
  });
  test('renderUsage marks expired', () => {
    const lines = renderUsage({ upload: 0, download: 0, total: 100, expire: Math.floor(Date.now() / 1000) - 86400 });
    expect(lines.some((l) => l.includes('已过期'))).toBe(true);
  });
  test('formatBytes units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.05 KB');
    expect(formatBytes(5e9)).toBe('5.00 GB');
  });
});

describe('mode command units', () => {
  test('writeMode/readMode roundtrip preserves other lines', async () => {
    {
      const path = join(tmpHome, '.vpn', 'config.yaml');
      writeFileSync(path, 'mode: rule\nport: 7890\n', { flag: 'w' });
      // 确保目录与文件已存在
      expect(await readMode()).toBe('rule');
      await writeMode('global');
      expect(await readMode()).toBe('global');
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('port: 7890');
      expect(text.match(/^mode:/gm)?.length).toBe(1);
    }
  });
});
