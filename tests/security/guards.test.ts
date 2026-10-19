import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuleProviders,
  safeProviderCachePath,
  type ProviderStore,
} from '../../src/rules/providers.ts';
import { parsePaddingScheme, planChunks, makeWasteFrame } from '../../src/outbound/anytls/padding.ts';
import { parseHomeKeys, mergeSource } from '../../src/config/settings.ts';
import { DEFAULT_CONFIG_YAML } from '../../src/config/defaults.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sec-'));
describe('provider cache path traversal', () => {
  test('benign names resolve inside cache dir', () => {
    expect(safeProviderCachePath(tmp, 'reject')).toBe(join(tmp, 'ruleset-reject.txt'));
    expect(safeProviderCachePath(tmp, 'telegramcidr')).toBe(join(tmp, 'ruleset-telegramcidr.txt'));
  });

  test('traversal names are rejected', () => {
    expect(safeProviderCachePath(tmp, 'a/../../pwned')).toBeNull();
    expect(safeProviderCachePath(tmp, '../escape')).toBeNull();
    expect(safeProviderCachePath(tmp, 'x/y')).toBeNull();
    expect(safeProviderCachePath(tmp, '')).toBeNull();
  });

  test('loadAll with traversal provider name never writes outside cache', async () => {
    const store: ProviderStore = {
      cacheDir: () => tmp,
      fetch: async () => 'payload:\n  - evil.example\n',
      readFile: async () => null,
      now: () => 1,
    };
    const rp = new RuleProviders(
      new Map([
        [
          'a/../../pwned',
          { name: 'a/../../pwned', behavior: 'domain', format: 'yaml', url: 'http://x/y', interval: 86400 },
        ],
      ]),
      store,
    );
    await rp.loadAll();
    expect(existsSync(join(tmp, '..', 'pwned.txt'))).toBe(false);
    expect(existsSync(join(tmp, 'ruleset-a..pwned.txt'))).toBe(false);
    rp.stop();
  });
});

describe('padding scheme bounds (server-controlled input)', () => {
  test('oversized padding values are rejected at parse', () => {
    expect(parsePaddingScheme('stop=8\n0=2000000000-2000000000')).toBeNull();
    expect(parsePaddingScheme('stop=8\n0=70000-70000')).toBeNull();
  });
  test('legit default scheme still parses', () => {
    const p = parsePaddingScheme('stop=8\n0=30-30\n1=100-400');
    expect(p).not.toBeNull();
  });
  test('waste frame construction enforces u16 length', () => {
    expect(() => makeWasteFrame(70000)).toThrow();
    expect(makeWasteFrame(65535).length).toBe(65535 + 7);
  });
  test('planChunks with hostile sizes clamps to protocol bound', () => {
    const plan = planChunks([4000000000], 100);
    for (const step of plan.steps) {
      expect(step.wasteLen).toBeLessThanOrEqual(65535);
    }
  });
});

describe('home config secret key honored', () => {
  test('empty quoted secret normalizes to empty string (template default)', () => {
    const k = parseHomeKeys("secret: ''");
    expect(k.secret).toBe('');
    const fromTemplate = parseHomeKeys(DEFAULT_CONFIG_YAML);
    expect(fromTemplate.secret).toBe('');
  });
  test('empty home secret does not override subscription secret', () => {
    const m = mergeSource({ homeConfigText: "secret: ''", dotenvText: null });
    expect(m.secret).toBe('');
  });
  test('parseHomeKeys extracts secret', () => {
    const k = parseHomeKeys("subscription-url: 'https://s/x'\nsecret: 'abc123'\nmode: rule");
    expect(k.secret).toBe('abc123');
  });
  test('mergeSource carries secret through', () => {
    const m = mergeSource({ homeConfigText: "secret: 'k'", dotenvText: null });
    expect(m.secret).toBe('k');
  });
  test('empty secret normalizes to empty string', () => {
    const m = mergeSource({ homeConfigText: '', dotenvText: null });
    expect(m.secret).toBe('');
  });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
void statSync;
void readFileSync;
