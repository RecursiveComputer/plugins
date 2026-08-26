import { describe, expect, it, vi } from 'vitest';

import handler from '../routes/verify.js';

describe('Local Computer onboarding verification route', () => {
  it('ignores unrelated requests', async () => {
    const send = vi.fn();

    await expect(
      handler({
        pathname: '/api/other',
        req: { method: 'POST' },
        res: {},
        send,
      }),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('verifies the saved Python and virtualization settings', async () => {
    const send = vi.fn();
    const res = {};
    const handled = await handler({
      pathname: '/api/computer-provider-cua-local/verify',
      req: { method: 'POST' },
      res,
      send,
      db: {
        getPluginSettings: () => ({
          pythonPath: 'missing-python-for-local-computer-test',
          image: 'linux',
          virtualMachine: true,
        }),
      },
    });

    expect(handled).toBe(true);
    expect(send).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({
        ok: false,
        message: expect.any(String),
        setup_hint: expect.stringContaining("-m pip install --upgrade 'cua-sandbox>=0.4.3' cua"),
      }),
    );
  });
});
