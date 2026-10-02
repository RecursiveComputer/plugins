import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createCloudflareProvider } from '../provider.ts';
import { handle, sameToken, type MachineStub, type StartInput } from '../worker/src/routes.ts';

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift() ?? { state: 'running' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const settings = { workerUrl: 'https://recursive-machines.me.workers.dev', apiToken: 'tok', instanceType: 'standard-2', idleMinutes: 60 };

test('the provider drives the Worker: start, pause, resume with a fresh enrollment, keep alive, status, remove', async () => {
  const { calls, fetchImpl } = fakeFetch([{ state: 'running' }, { state: 'stopped' }, { state: 'running' }, { state: 'running' }, { state: 'stopped' }, { state: 'not_found' }]);
  const provider = createCloudflareProvider(settings, fetchImpl);
  const started = await provider.start({ machine_id: 'mch_1', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'e1' } } });
  assert.equal(started.instance_id, 'mch_1');
  await provider.stop!('mch_1');
  await provider.resume!('mch_1', { bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'e2' } } });
  await provider.keepAlive!('mch_1');
  assert.equal(await provider.status!('mch_1'), 'stopped');
  await provider.destroy('mch_1');

  assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), [
    'POST /machines/mch_1/start',
    'POST /machines/mch_1/stop',
    'POST /machines/mch_1/resume',
    'POST /machines/mch_1/keepalive',
    'GET /machines/mch_1',
    'DELETE /machines/mch_1',
  ]);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'e1' }, instance: 'standard-2', idle_minutes: 60 });
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)).env, { RECURSIVE_MACHINE_ENROLL: 'e2' });
});

test('the provider explains missing setup', async () => {
  const provider = createCloudflareProvider({ ...settings, workerUrl: '', apiToken: '' });
  await assert.rejects(provider.start({ machine_id: 'm', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /Deploy the Recursive machines Worker/);
});

function recordingStub() {
  const calls: string[] = [];
  const reply = (name: string) => async (input?: unknown) => {
    calls.push(input === undefined ? name : `${name} ${JSON.stringify(input)}`);
    return { state: 'running' as const };
  };
  const stub: MachineStub = {
    startMachine: reply('start') as (input: StartInput) => Promise<{ state: 'running' }>,
    stopMachine: reply('stop'),
    resumeMachine: reply('resume'),
    keepAlive: reply('keepalive'),
    destroyMachine: reply('destroy'),
    state: reply('state'),
  };
  return { calls, stub };
}

const request = (method: string, path: string, body?: unknown, token = 'secret') =>
  new Request(`https://w.example${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });

test('the Worker routes authenticated requests to the machine’s Durable Object', async () => {
  const { calls, stub } = recordingStub();
  const ids: string[] = [];
  const stubFor = (id: string) => (ids.push(id), stub);
  assert.equal((await handle(request('GET', '/health'), 'secret', stubFor)).status, 200);
  await handle(request('POST', '/machines/mch_1/start', { command: 'run', env: { A: 'b', N: 1 }, instance: 'basic', idle_minutes: 30 }), 'secret', stubFor);
  await handle(request('POST', '/machines/mch_1/resume', { env: { RECURSIVE_MACHINE_ENROLL: 'e2' } }), 'secret', stubFor);
  await handle(request('POST', '/machines/mch_1/stop'), 'secret', stubFor);
  await handle(request('POST', '/machines/mch_1/keepalive'), 'secret', stubFor);
  await handle(request('GET', '/machines/mch_1'), 'secret', stubFor);
  await handle(request('DELETE', '/machines/mch_1'), 'secret', stubFor);
  assert.deepEqual(calls, [
    'start {"command":"run","env":{"A":"b"},"instance":"basic","idle_minutes":30}',
    'resume {"env":{"RECURSIVE_MACHINE_ENROLL":"e2"}}',
    'stop',
    'keepalive',
    'state',
    'destroy',
  ]);
  assert.ok(ids.every((id) => id === 'mch_1'));
});

test('the Worker refuses bad tokens, a missing secret, bad ids, and a start without a command', async () => {
  const { calls, stub } = recordingStub();
  const stubFor = () => stub;
  assert.equal((await handle(request('GET', '/machines/mch_1', undefined, 'wrong'), 'secret', stubFor)).status, 401);
  assert.equal((await handle(request('GET', '/machines/mch_1'), undefined, stubFor)).status, 500);
  assert.equal((await handle(request('GET', '/machines/a.b'), 'secret', stubFor)).status, 404);
  assert.equal((await handle(request('PUT', '/machines/mch_1/start'), 'secret', stubFor)).status, 405);
  const missing = await handle(request('POST', '/machines/mch_1/start', { env: {} }), 'secret', stubFor);
  assert.equal(missing.status, 500);
  assert.match(await missing.text(), /command is required/);
  assert.deepEqual(calls, []);
  assert.equal(sameToken('abc', 'abd'), false);
  assert.equal(sameToken('', ''), false);
});
