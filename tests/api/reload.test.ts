import { expect, test } from 'bun:test';
import { RestApi } from '../../src/api/server.ts';
import { ConnectionTracker } from '../../src/core/connections.ts';
import { RuleEngine } from '../../src/rules/index.ts';
import { hotReload } from '../../src/config/reload.ts';

function createApi(reloadConfig?: () => Promise<void>) {
  return new RestApi({
    tracker: new ConnectionTracker(),
    loopbackPort: 0,
    outboundOf: () => undefined,
    outboundNames: () => [],
    engine: new RuleEngine({ rules: [], providers: new Map(), geoip: null, final: 'DIRECT' }),
    secret: 'test-secret',
    setMode: () => true,
    currentMode: () => 'rule',
    reloadConfig,
  });
}

test('reload requires authentication, rejects concurrent refreshes, and recovers after failure', async () => {
  let unblock: () => void = () => {};
  let entered: () => void = () => {};
  let fail = false;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const api = createApi(async () => {
    if (fail) throw new Error('sensitive-url');
    entered();
    await new Promise<void>((resolve) => { unblock = resolve; });
  });
  await api.start('127.0.0.1:0');
  const base = `http://127.0.0.1:${api.port}/configs/reload`;
  const headers = { authorization: 'Bearer test-secret' };
  try {
    expect((await fetch(base, { method: 'POST' })).status).toBe(401);
    expect(await hotReload(api.port, 'wrong')).toBe('failed');
    expect((await fetch(base, {
      method: 'POST', headers: { ...headers, host: 'attacker.test' },
    })).status).toBe(403);
    const first = fetch(base, { method: 'POST', headers });
    await started;
    expect((await fetch(base, { method: 'POST', headers })).status).toBe(409);
    unblock();
    expect((await first).status).toBe(204);
    fail = true;
    const failed = await fetch(base, { method: 'POST', headers });
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('sensitive-url');
    expect(await hotReload(api.port, 'test-secret')).toBe('failed');
  } finally {
    unblock();
    api.stop();
  }
});

test('reload reports old kernels without reload support and an offline kernel separately', async () => {
  const api = createApi();
  await api.start('127.0.0.1:0');
  const port = api.port;
  try {
    expect((await fetch(`http://127.0.0.1:${port}/configs/reload`, {
      method: 'POST', headers: { authorization: 'Bearer test-secret' },
    })).status).toBe(501);
    expect(await hotReload(port, 'test-secret')).toBe('failed');
  } finally {
    api.stop();
  }
  expect(await hotReload(port, 'test-secret')).toBe('not-running');
});
