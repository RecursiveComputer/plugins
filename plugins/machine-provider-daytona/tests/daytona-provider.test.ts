import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDaytonaProvider, detachedCommand } from '../provider.ts';

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift() ?? {}), { status: 200 });
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
  const { calls, fetchImpl } = fakeFetch([{}, { id: 'dt1', state: 'started' }, {}]);
  const provider = createDaytonaProvider(settings, fetchImpl, async () => undefined);
  await provider.resume!('dt1', { bootstrap: { command: 'unused', env: { RECURSIVE_MACHINE_ENROLL: 'fresh', RECURSIVE_HOME_URL: 'h' } } });
  assert.equal(calls[0]!.url, 'https://app.daytona.io/api/sandbox/dt1/start');
  const exec = JSON.parse(String(calls[2]!.init.body));
  assert.match(exec.command, /recursive-runner\/start\.sh/);
  assert.deepEqual(exec.envs, { RECURSIVE_MACHINE_ENROLL: 'fresh' }, 'a fresh enrollment in case the runner lost its identity');
});

test('keep-alive is a toolbox call, which Daytona counts as activity', async () => {
  const { calls, fetchImpl } = fakeFetch([{ id: 'dt1', state: 'started', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox' }, {}]);
  await createDaytonaProvider(settings, fetchImpl, async () => undefined).keepAlive!('dt1');
  assert.equal(`${calls[1]!.init.method} ${calls[1]!.url}`, 'POST https://proxy.app.daytona.io/toolbox/dt1/process/execute');
  assert.equal(JSON.parse(String(calls[1]!.init.body)).command, 'true');
});
