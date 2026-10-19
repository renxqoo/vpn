import { describe, expect, test } from 'bun:test';
import { fetchUserinfo, parseUserinfo } from '../../src/config/usage.ts';

describe('fetchUserinfo result discrimination', () => {
  test('unreachable host → network-error, not unsupported', async () => {
    const r = await fetchUserinfo('http://127.0.0.1:1/nope');
    expect(r.kind).toBe('network-error');
  });
  test('local server without header → unsupported', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    });
    try {
      const r = await fetchUserinfo(`http://127.0.0.1:${server.port}/sub`);
      expect(r.kind).toBe('unsupported');
    } finally {
      server.stop(true);
    }
  });
  test('HTTP rejection → network-error with status, not unsupported', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('PLEASE UPGRADE CLIENT', { status: 403 }),
    });
    try {
      const r = await fetchUserinfo(`http://127.0.0.1:${server.port}/sub`);
      expect(r.kind).toBe('network-error');
      if (r.kind === 'network-error') expect(r.error).toContain('HTTP 403');
    } finally {
      server.stop(true);
    }
  });
  test('local server with header → ok + parsed', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response('ok', {
          headers: { 'subscription-userinfo': 'upload=10; download=20; total=100; expire=2000000000' },
        }),
    });
    try {
      const r = await fetchUserinfo(`http://127.0.0.1:${server.port}/sub`);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.usage.total).toBe(100);
        expect(r.usage.expire).toBe(2000000000);
      }
    } finally {
      server.stop(true);
    }
  });
});
