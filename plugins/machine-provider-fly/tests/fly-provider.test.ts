import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createFlyProvider } from '../provider.ts';

test('creates a Fly machine whose init command is the bootstrap', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'fly123', state: 'started' }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = createFlyProvider({ apiToken: 'fo1_x', app: 'my-agents', region: 'iad', image: 'node:22-bookworm', cpus: 2, memoryMb: 4096 }, fetchImpl);
  const result = await provider.start({ machine_id: 'mch_A1', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'tok' } } });
  assert.equal(result.instance_id, 'fly123');
  assert.equal(calls[0]!.url, 'https://api.machines.dev/v1/apps/my-agents/machines');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.region, 'iad');
  assert.deepEqual(body.config.init, { entrypoint: ['/bin/sh', '-c'], cmd: ['curl x | sh'] });
  assert.deepEqual(body.config.env, { RECURSIVE_MACHINE_ENROLL: 'tok' });
  assert.equal(body.config.guest.memory_mb, 4096);
  await provider.stop!('fly123');
  await provider.resume!('fly123');
  await provider.destroy('fly123');
  assert.deepEqual(calls.slice(1).map((call) => `${call.init.method} ${new URL(call.url).pathname}${new URL(call.url).search}`), [
    'POST /v1/apps/my-agents/machines/fly123/stop',
    'POST /v1/apps/my-agents/machines/fly123/start',
    'DELETE /v1/apps/my-agents/machines/fly123?force=true',
  ]);
  assert.equal(await provider.status!('fly123'), 'running');
});

test('explains missing configuration', async () => {
  const provider = createFlyProvider({ apiToken: '', app: '', region: '', image: 'x', cpus: 1, memoryMb: 256 });
  await assert.rejects(provider.start({ machine_id: 'm', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /Fly API token and app/);
});
