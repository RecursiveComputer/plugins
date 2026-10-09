import { defineOperation, wirePluginOperations } from '@recursivecomputer/plugin-sdk';
import { verifyLocalComputer } from './provider.js';

export const verifyOperation = defineOperation<Record<string, never>, { ok: boolean; message?: string }>({
  id: 'computer-provider-cua-local.onboarding.verify', version: 1, stability: 'experimental',
  summary: 'Verify the saved computer-provider-cua-local provider settings.',
  method: 'POST', path: '/api/product/v1/computer-provider-cua-local/onboarding/verify',
  tier: 'public', capability: 'plugins.manage', scope: { project: 'none', data: 'user' },
  kind: 'command', sideEffects: 'idempotent', idempotency: 'required', concurrency: 'none', result: 'immediate',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'], additionalProperties: false },
  errors: ['unauthenticated', 'forbidden', 'write_failed'], mcp: { exposed: false, destructive: false },
});
export default { operations: wirePluginOperations({ verify: verifyOperation }, {
  verify: async (_input, context) => {
    const settings = await context.host.pluginSettings.get();
    const result = await verifyLocalComputer(settings);
    return { ok: result.ok, message: result.message };
  },
}, context => context) };
