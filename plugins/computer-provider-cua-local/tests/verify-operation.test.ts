import { expect, it, vi } from 'vitest';
const verify = vi.hoisted(() => vi.fn(async () => ({ ok: false, message: 'Runtime unavailable', setup_hint: 'Install runtime' })));
const settings = vi.hoisted(() => vi.fn(() => ({ pythonPath: 'test-python' })));
vi.mock('../provider.js', () => ({ verifyLocalComputer: verify }));
import module from '../operations.js';
it('uses the owner runtime verifier and returns the declared public result', async () => {
  const operation = module.operations[0];
  expect(operation.definition.id).toBe('computer-provider-cua-local.onboarding.verify');
  expect(await operation.execute({}, { pluginId: 'computer-provider-cua-local', storage: {}, host: { pluginSettings: { get: settings } }, emit: async () => {} })).toEqual({ ok: false, message: 'Runtime unavailable' });
  expect(settings).toHaveBeenCalledWith();
  expect(verify).toHaveBeenCalledWith({ pythonPath: 'test-python' });
});
