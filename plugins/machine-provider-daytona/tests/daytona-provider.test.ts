import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDaytonaProvider, detachedCommand } from '../provider.ts';

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? {};
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && 'httpStatus' in next) return new Response('nope', { status: (next as { httpStatus: number }).httpStatus });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const settings = { apiKey: 'dtn_key', apiUrl: 'https://app.daytona.io/api', snapshot: '', cpu: 2, memory: 4, disk: 10, autoStopMinutes: 60 };

test('creates a sandbox, waits until started, and launches the runner through the toolbox', async () => {
  const { calls, fetchImpl } = fakeFetch([
    { id: 'dt1', state: 'creating' },
    { id: 'dt1', state: 'starting' },
    { id: 'dt1', state: 'started', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox' },
    { exitCode: 0, result: '' },
  ]);
  const provider = createDaytonaProvider(settings, fetchImpl, async () => undefined);
  const result = await provider.start({ machine_id: 'mch_1', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'tok' } } });
  assert.equal(result.instance_id, 'dt1');
  assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [
    'POST https://app.daytona.io/api/sandbox',
    'GET https://app.daytona.io/api/sandbox/dt1',
    'GET https://app.daytona.io/api/sandbox/dt1',
    'POST https://proxy.app.daytona.io/toolbox/dt1/process/execute',
  ]);
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer dtn_key');
  const created = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual({ env: created.env, autoStopInterval: created.autoStopInterval }, { env: { RECURSIVE_MACHINE_ENROLL: 'tok' }, autoStopInterval: 60 }, 'Daytona\'s timer backs home up');
  const exec = JSON.parse(String(calls[3]!.init.body));
  assert.equal(exec.command, detachedCommand('curl x | sh'));
  assert.deepEqual(exec.envs, { RECURSIVE_MACHINE_ENROLL: 'tok' });
});

test('resume restarts the sandbox and its runner from the saved start script', async () => {
  const { calls, fetchImpl } = fakeFetch([{ id: 'dt1', state: 'stopped' }, {}, { id: 'dt1', state: 'started' }, {}]);
  const provider = createDaytonaProvider(settings, fetchImpl, async () => undefined);
  await provider.resume!('dt1', { bootstrap: { command: 'unused', env: { RECURSIVE_MACHINE_ENROLL: 'fresh', RECURSIVE_HOME_URL: 'h' } } });
  assert.equal(calls[1]!.url, 'https://app.daytona.io/api/sandbox/dt1/start');
  const exec = JSON.parse(String(calls[3]!.init.body));
  assert.match(exec.command, /recursive-runner\/start\.sh/);
  assert.deepEqual(exec.envs, { RECURSIVE_MACHINE_ENROLL: 'fresh' }, 'a fresh enrollment in case the runner lost its identity');
});

test('keep-alive is a toolbox call, which Daytona counts as activity', async () => {
  const { calls, fetchImpl } = fakeFetch([{ id: 'dt1', state: 'started', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox' }, {}]);
  await createDaytonaProvider(settings, fetchImpl, async () => undefined).keepAlive!('dt1');
  assert.equal(`${calls[1]!.init.method} ${calls[1]!.url}`, 'POST https://proxy.app.daytona.io/toolbox/dt1/process/execute');
  assert.equal(JSON.parse(String(calls[1]!.init.body)).command, 'true');
});

test('a sandbox it cannot reach is not reported gone; only a 404 is', async () => {
  const flaky = fakeFetch([{ httpStatus: 503 }, { httpStatus: 503 }, { httpStatus: 503 }]);
  await assert.rejects(createDaytonaProvider(settings, flaky.fetchImpl, async () => undefined).status!('dt1'), /503/);
  assert.equal(flaky.calls.length, 3);
  const gone = fakeFetch([{ httpStatus: 404 }]);
  assert.equal(await createDaytonaProvider(settings, gone.fetchImpl, async () => undefined).status!('dt1'), 'not_found');
  const recovered = fakeFetch([{ httpStatus: 502 }, { id: 'dt1', state: 'started' }]);
  assert.equal(await createDaytonaProvider(settings, recovered.fetchImpl, async () => undefined).status!('dt1'), 'running');
});

test('deletes a sandbox whose runner could not be started, and never retries creating one', async () => {
  const { calls, fetchImpl } = fakeFetch([
    { id: 'dt9', state: 'creating' },
    { id: 'dt9', state: 'error' },
    {},
  ]);
  await assert.rejects(createDaytonaProvider(settings, fetchImpl, async () => undefined).start({ machine_id: 'mch_9', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /state error/);
  assert.equal(`${calls.at(-1)!.init.method} ${calls.at(-1)!.url}`, 'DELETE https://app.daytona.io/api/sandbox/dt9');
  const busy = fakeFetch([{ httpStatus: 503 }]);
  await assert.rejects(createDaytonaProvider(settings, busy.fetchImpl, async () => undefined).start({ machine_id: 'mch_9', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /503/);
  assert.equal(busy.calls.length, 1);
});

test('resuming a sandbox that is already running only relaunches its runner; stopping a stopped one does nothing', async () => {
  const running = fakeFetch([{ id: 'dt1', state: 'started' }, { id: 'dt1', state: 'started' }, {}]);
  await createDaytonaProvider(settings, running.fetchImpl, async () => undefined).resume!('dt1');
  assert.ok(!running.calls.some((call) => call.url.endsWith('/start')));
  assert.match(running.calls.at(-1)!.url, /process\/execute$/);
  const stopped = fakeFetch([{ id: 'dt1', state: 'stopped' }]);
  await createDaytonaProvider(settings, stopped.fetchImpl, async () => undefined).stop!('dt1');
  assert.equal(stopped.calls.length, 1);
});

test('lists the sandboxes Recursive made, for the sweep of ones no machine tracks', async () => {
  const { fetchImpl } = fakeFetch([[
    { id: 'dt1', state: 'started', createdAt: '2026-11-26T00:00:00Z', labels: { 'computer.recursive.machine': 'mch_1', 'computer.recursive.registry': 'reg_1' } },
    { id: 'dt2', state: 'stopped', labels: { 'computer.recursive.machine': 'mch_2' } },
    { id: 'dt3', state: 'destroyed', labels: { 'computer.recursive.machine': 'mch_3' } },
    { id: 'other', state: 'started', labels: {} },
  ]]);
  assert.deepEqual(await createDaytonaProvider(settings, fetchImpl, async () => undefined).list(), [
    { instance_id: 'dt1', machine_id: 'mch_1', registry_id: 'reg_1', state: 'running', created_at: Date.parse('2026-11-26T00:00:00Z') },
    { instance_id: 'dt2', machine_id: 'mch_2', registry_id: null, state: 'stopped', created_at: null },
  ]);
});
