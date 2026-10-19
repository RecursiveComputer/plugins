import { defineOperation, wirePluginOperations, type DefineOperationSpec } from '@recursivecomputer/plugin-sdk';

import { createLayaTransport, layaSettings, verifyLayaConnection } from './lib/laya-client.js';

type VerifyOutput = { ok: boolean; message?: string };

// `effect` is newer than some published SDKs' operation spec type: asserted so both compile,
// and hosts that know command effects read it.
export const verifyOperation = defineOperation<Record<string, never>, VerifyOutput>({
  id: 'laya.onboarding.verify',
  version: 1,
  stability: 'experimental',
  summary: 'Load the configured Laya checkpoint and run a probe question through it.',
  method: 'POST',
  path: '/api/product/v1/laya/onboarding/verify',
  tier: 'public',
  capability: 'laya.manage',
  scope: { project: 'none', data: 'user' },
  kind: 'command',
  effect: 'await',
  sideEffects: 'idempotent',
  idempotency: 'required',
  concurrency: 'none',
  result: 'immediate',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
    required: ['ok'],
    additionalProperties: false,
  },
  errors: ['unauthenticated', 'forbidden', 'write_failed'],
  mcp: { exposed: false, destructive: false },
} as DefineOperationSpec<Record<string, never>, VerifyOutput>);

export default {
  operations: wirePluginOperations(
    { verify: verifyOperation },
    {
      verify: async (_input, context) => {
        const settings = layaSettings((await context.host?.pluginSettings?.get?.()) ?? {});
        const result = await verifyLayaConnection(createLayaTransport(settings), settings);
        return { ok: result.ok, message: result.message };
      },
    },
    (context) => context,
  ),
};
