import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createFlyProvider, volumeName } from '../provider.ts';

const base = { apiToken: 'fo1_x', app: 'my-agents', region: 'iad', image: 'node:22-bookworm', cpus: 2, memoryMb: 4096, persistDisk: false, volumeSizeGb: 10 };

function fakeFetch(respond: (method: string, path: string) => { status?: number; body?: unknown } = () => ({})) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = respond(init.method ?? 'GET', new URL(url).pathname);
    return new Response(JSON.stringify(body ?? { id: 'fly123', state: 'started' }), { status: status ?? 200 });
  }) as unknown as typeof fetch;
  const routes = () => calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}${new URL(call.url).search}`);
  return { calls, fetchImpl, routes };
}

test('creates a Fly machine whose init command is the bootstrap', async () => {
  const { calls, fetchImpl, routes } = fakeFetch();
  const provider = createFlyProvider(base, fetchImpl);
  const result = await provider.start({ machine_id: 'mch_A1', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'tok' } } });
  assert.equal(result.instance_id, 'fly123');
  assert.equal(calls[0]!.url, 'https://api.machines.dev/v1/apps/my-agents/machines');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.region, 'iad');
  assert.deepEqual(body.config.init, { entrypoint: ['/bin/sh', '-c'], cmd: ['curl x | sh'] });
  assert.deepEqual(body.config.env, { RECURSIVE_MACHINE_ENROLL: 'tok' });
  assert.equal(body.config.guest.memory_mb, 4096);
  assert.equal(body.config.mounts, undefined);
  await provider.stop!('fly123');
  await provider.resume!('fly123');
  await provider.destroy('fly123');
  assert.deepEqual(routes().slice(1), [
    'POST /v1/apps/my-agents/machines/fly123/stop',
    'POST /v1/apps/my-agents/machines/fly123/start',
    'GET /v1/apps/my-agents/machines/fly123',
    'DELETE /v1/apps/my-agents/machines/fly123?force=true',
  ]);
  assert.equal(await provider.status!('fly123'), 'running');
});

test('keeps the runner’s state and checkouts on a volume that survives restarts, and deletes it with the machine', async () => {
  const { calls, fetchImpl, routes } = fakeFetch((method, path) => {
    if (method === 'POST' && path.endsWith('/volumes')) return { body: { id: 'vol_1' } };
    if (method === 'GET') return { body: { id: 'fly123', config: { mounts: [{ volume: 'vol_1', path: '/data' }] } } };
    return {};
  });
  const provider = createFlyProvider({ ...base, region: '', persistDisk: true }, fetchImpl, async () => undefined);
  await provider.start({ machine_id: 'mch_A1', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'tok' } } });
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { name: volumeName('mch_A1'), region: 'iad', size_gb: 10 });
  const machine = JSON.parse(String(calls[1]!.init.body));
  assert.equal(machine.region, 'iad', 'the machine lands where its volume is');
  assert.deepEqual(machine.config.mounts, [{ volume: 'vol_1', path: '/data' }]);
  assert.equal(machine.config.env.RECURSIVE_RUNNER_DIR, '/data/runner');
  assert.equal(machine.config.env.RECURSIVE_RUNNER_WORKSPACES, '/data/sessions');
  await provider.destroy('fly123');
  assert.deepEqual(routes().slice(2), ['GET /v1/apps/my-agents/machines/fly123', 'DELETE /v1/apps/my-agents/machines/fly123?force=true', 'DELETE /v1/apps/my-agents/volumes/vol_1']);
  assert.match(volumeName('mch_ABCDEF123456'), /^[a-z0-9_]{1,30}$/);
});

test('without a volume, resume writes the fresh enrollment into the machine before starting it', async () => {
  const { calls, fetchImpl, routes } = fakeFetch((method) => (method === 'GET' ? { body: { id: 'fly123', config: { image: 'i', env: { RECURSIVE_MACHINE_ENROLL: 'spent', KEEP: '1' } } } } : {}));
  await createFlyProvider(base, fetchImpl).resume!('fly123', { bootstrap: { command: 'x', env: { RECURSIVE_MACHINE_ENROLL: 'fresh' } } });
  assert.deepEqual(routes(), ['GET /v1/apps/my-agents/machines/fly123', 'POST /v1/apps/my-agents/machines/fly123', 'POST /v1/apps/my-agents/machines/fly123/start']);
  const update = JSON.parse(String(calls[1]!.init.body));
  assert.deepEqual(update.config.env, { RECURSIVE_MACHINE_ENROLL: 'fresh', KEEP: '1' });
  assert.equal(update.skip_launch, true);
});

test('a failed machine create removes the volume it made', async () => {
  const { fetchImpl, routes } = fakeFetch((method, path) => {
    if (path.endsWith('/volumes')) return { body: { id: 'vol_9' } };
    if (method === 'POST' && path.endsWith('/machines')) return { status: 422, body: { error: 'bad' } };
    return {};
  });
  await assert.rejects(createFlyProvider({ ...base, persistDisk: true }, fetchImpl).start({ machine_id: 'm', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /422/);
  assert.deepEqual(routes(), ['POST /v1/apps/my-agents/volumes', 'POST /v1/apps/my-agents/machines', 'DELETE /v1/apps/my-agents/volumes/vol_9']);
});

test('explains missing configuration', async () => {
  const provider = createFlyProvider({ ...base, apiToken: '', app: '', region: '', image: 'x', cpus: 1, memoryMb: 256 });
  await assert.rejects(provider.start({ machine_id: 'm', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /Fly API token and app/);
});
