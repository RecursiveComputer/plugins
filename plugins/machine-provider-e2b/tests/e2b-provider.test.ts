import assert from 'node:assert/strict';
import { test } from 'vitest';
import plugin, { connectEnvelope, createE2bProvider, detachedCommand } from '../provider.ts';

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

test('envelopes and status', async () => {
  assert.deepEqual([...connectEnvelope({ a: 1 }).subarray(0, 5)], [0, 0, 0, 0, 7]);
  const status = await plugin.status!({ plugin_id: 'machine-provider-e2b', settings: { apiKey: '' } });
  assert.equal(status.configured, Boolean(process.env.E2B_API_KEY));
});
