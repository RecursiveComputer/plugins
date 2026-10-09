import { defineOperation, wirePluginOperations } from '@recursivecomputer/plugin-sdk';

import { createLayaTransport, layaSettings, verifyLayaConnection } from './lib/laya-client.js';

export const verifyOperation = defineOperation<Record<string, never>, { ok: boolean; message?: string }>({
  id: 'laya.onboarding.verify',
  version: 1,
  stability: 'experimental',
  summary: 'Load the configured Laya checkpoint and run a probe question through it.',
  method: 'POST',
  path: '/api/product/v1/laya/onboarding/verify',
  tier: 'public',
  capability: 'plugins.manage',
  scope: { project: 'none', data: 'user' },
  kind: 'command',
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
});

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
