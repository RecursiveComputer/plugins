import { expect, it, vi } from 'vitest';

const verify = vi.hoisted(() => vi.fn(async () => ({ ok: false, message: 'laya not importable', setup_hint: 'pip install laya' })));
const settings = vi.hoisted(() => vi.fn(async () => ({ pythonPath: 'test-python', model: 'english' })));

vi.mock('../lib/laya-client.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/laya-client.js')>();
  return { ...actual, verifyLayaConnection: verify };
});

import module from '../operations.js';

it('verifies the saved settings and returns only the declared public result', async () => {
  const operation = module.operations[0]!;
  expect(operation.definition.id).toBe('laya.onboarding.verify');
  const result = await operation.execute(
    {},
    { pluginId: 'laya', storage: {}, host: { pluginSettings: { get: settings } }, emit: async () => {} } as never,
  );
  expect(result).toEqual({ ok: false, message: 'laya not importable' });
  expect(verify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pythonPath: 'test-python', model: 'english' }));
});
