import assert from 'node:assert/strict';
import { test } from 'vitest';
import plugin, { connectEnvelope, connectStreamError, createE2bProvider, detachedCommand } from '../provider.ts';

function fakeFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? {};
    return new Response(next.body === undefined ? '' : typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const settings = { apiKey: 'e2b_key', template: 'base', timeoutSeconds: 3600, domain: 'e2b.app' };

test('creates a sandbox with the bootstrap env, then starts the runner detached through envd', async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: { sandboxID: 'sbx1', envdAccessToken: 'envd-tok', domain: null } }, { body: '' }]);
  const provider = createE2bProvider(settings, fetchImpl);
  const result = await provider.start({ machine_id: 'mch_1', owner_principal_id: 'o', bootstrap: { command: 'curl x | sh', env: { RECURSIVE_MACHINE_ENROLL: 'tok' } } });
  assert.equal(result.instance_id, 'sbx1');

  assert.equal(calls[0]!.url, 'https://api.e2b.app/sandboxes');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-API-KEY'], 'e2b_key');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual({ templateID: body.templateID, autoPause: body.autoPause, envVars: body.envVars }, { templateID: 'base', autoPause: true, envVars: { RECURSIVE_MACHINE_ENROLL: 'tok' } });

  assert.equal(calls[1]!.url, 'https://sandbox.e2b.app/process.Process/Start');
  const headers = calls[1]!.init.headers as Record<string, string>;
  assert.equal(headers['E2b-Sandbox-Id'], 'sbx1');
  assert.equal(headers['E2b-Sandbox-Port'], '49983');
  assert.equal(headers['X-Access-Token'], 'envd-tok');
  assert.equal(headers['content-type'], 'application/connect+json');
  const envelope = calls[1]!.init.body as Uint8Array;
  assert.equal(envelope[0], 0);
  const message = JSON.parse(Buffer.from(envelope.subarray(5)).toString());
  assert.equal(new DataView(envelope.buffer, envelope.byteOffset).getUint32(1), envelope.length - 5);
  assert.equal(message.process.cmd, '/bin/bash');
  assert.equal(message.process.args[2], detachedCommand('curl x | sh'));
});

test('pause, resume, destroy map to the E2B API and tolerate already-done states', async () => {
  const { calls, fetchImpl } = fakeFetch([{ status: 409, body: 'already paused' }, { body: {} }, { status: 404, body: 'gone' }]);
  const provider = createE2bProvider(settings, fetchImpl);
  await provider.stop!('sbx1');
  await provider.resume!('sbx1');
  await provider.destroy('sbx1');
  assert.deepEqual(calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`), ['POST /sandboxes/sbx1/pause', 'POST /sandboxes/sbx1/connect', 'DELETE /sandboxes/sbx1']);
});

test('keep-alive restarts the sandbox timeout so a long job is not paused mid-turn', async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: '' }]);
  await createE2bProvider(settings, fetchImpl).keepAlive!('sbx1');
  assert.equal(`${calls[0]!.init.method} ${new URL(calls[0]!.url).pathname}`, 'POST /sandboxes/sbx1/timeout');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { timeout: 3600 });
});

test('envelopes and status', async () => {
  assert.deepEqual([...connectEnvelope({ a: 1 }).subarray(0, 5)], [0, 0, 0, 0, 7]);
  const status = await plugin.status!({ plugin_id: 'machine-provider-e2b', settings: { apiKey: '' } });
  assert.equal(status.configured, Boolean(process.env.E2B_API_KEY));
});

const noWait = async () => undefined;

function endFrame(message: unknown): Uint8Array {
  const frame = connectEnvelope(message);
  frame[0] = 0x02;
  return frame;
}

test('a sandbox it cannot reach is not reported gone; only a 404 is', async () => {
  const flaky = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
  await assert.rejects(createE2bProvider(settings, flaky.fetchImpl, noWait).status!('sbx1'), /503/);
  assert.equal(flaky.calls.length, 3);
  const gone = fakeFetch([{ status: 404 }]);
  assert.equal(await createE2bProvider(settings, gone.fetchImpl, noWait).status!('sbx1'), 'not_found');
  const recovered = fakeFetch([{ status: 502 }, { body: { state: 'paused' } }]);
  assert.equal(await createE2bProvider(settings, recovered.fetchImpl, noWait).status!('sbx1'), 'stopped');
});

test('reads an error from the launch stream, deletes the sandbox, and never retries creating one', async () => {
  assert.equal(connectStreamError(endFrame({})), null);
  assert.equal(connectStreamError(endFrame({ error: { code: 'unavailable', message: 'envd not ready' } })), 'envd not ready');
  const failed = new Uint8Array(endFrame({ error: { code: 'unavailable', message: 'envd not ready' } }));
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    if (url.endsWith('/process.Process/Start')) return new Response(failed, { status: 200 });
    return new Response(JSON.stringify(url.endsWith('/sandboxes') ? { sandboxID: 'sbx2' } : {}), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(createE2bProvider(settings, fetchImpl, noWait).start({ machine_id: 'mch_2', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /envd not ready/);
  assert.equal(calls.at(-1), 'DELETE https://api.e2b.app/sandboxes/sbx2');
  const busy = fakeFetch([{ status: 503 }]);
  await assert.rejects(createE2bProvider(settings, busy.fetchImpl, noWait).start({ machine_id: 'mch_2', owner_principal_id: 'o', bootstrap: { command: 'x', env: {} } }), /503/);
  assert.equal(busy.calls.length, 1);
});

test('lists the sandboxes Recursive made, for the sweep of ones no machine tracks', async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: [
    { sandboxID: 'sbx1', state: 'running', startedAt: '2026-11-26T00:00:00Z', metadata: { recursive_machine_id: 'mch_1', recursive_registry_id: 'reg_1' } },
    { sandboxID: 'sbx2', state: 'paused', metadata: { recursive_machine_id: 'mch_2' } },
    { sandboxID: 'other', state: 'running', metadata: {} },
  ] }]);
  assert.deepEqual(await createE2bProvider(settings, fetchImpl, noWait).list(), [
    { instance_id: 'sbx1', machine_id: 'mch_1', registry_id: 'reg_1', state: 'running', created_at: Date.parse('2026-11-26T00:00:00Z') },
    { instance_id: 'sbx2', machine_id: 'mch_2', registry_id: null, state: 'stopped', created_at: null },
  ]);
  assert.match(calls[0]!.url, /\/v2\/sandboxes\?state=running&state=paused/);
});
