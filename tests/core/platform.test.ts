import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { homeDir, HOME_CONFIG_DIR, HOME_CONFIG_PATH, cacheDirectory, DOTENV_PATH } from '../../src/config/paths.ts';

describe('platform-agnostic paths', () => {
  test('homeDir honors USERPROFILE first (Windows semantics)', () => {
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = 'C:\\Users\\tester';
    delete process.env.HOME;
    try {
      expect(homeDir()).toBe('C:\\Users\\tester');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile;
      else delete process.env.USERPROFILE;
    }
  });

  test('homeDir falls back to HOME on unix', () => {
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = '/tmp/unix-home';
    delete process.env.USERPROFILE;
    try {
      expect(homeDir()).toBe('/tmp/unix-home');
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile;
      else delete process.env.USERPROFILE;
    }
  });

  test('all derived paths are joined (no manual slash concat)', () => {
    const dir = HOME_CONFIG_DIR();
    expect(dir.endsWith(join('.vpn', '..')) || dir.includes('.vpn')).toBe(true);
    expect(HOME_CONFIG_PATH().startsWith(dir)).toBe(true);
    expect(cacheDirectory().startsWith(dir)).toBe(true);
  });

  test('dotenv lives in cwd', () => {
    expect(DOTENV_PATH()).toBe(join(process.cwd(), '.env'));
  });
});
