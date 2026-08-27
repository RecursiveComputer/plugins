import { beforeEach, describe, expect, it, vi } from 'vitest';

const e2b = vi.hoisted(() => {
  const sandbox = {
    sandboxId: 'sandbox-1',
    isRunning: vi.fn(),
    setTimeout: vi.fn(),
    pause: vi.fn(),
    screenshot: vi.fn(),
    getScreenSize: vi.fn(),
    stream: {
      start: vi.fn(),
      stop: vi.fn(),
      getAuthKey: vi.fn(),
      getUrl: vi.fn(),
    },
    commands: { run: vi.fn() },
    files: { read: vi.fn(), write: vi.fn() },
  };
  return {
    sandbox,
    create: vi.fn(),
    connect: vi.fn(),
    kill: vi.fn(),
  };
});

vi.mock('@e2b/desktop', () => ({
  Sandbox: class {
    static create = e2b.create;
    static connect = e2b.connect;
    static kill = e2b.kill;
  },
}));

import { E2bSandboxProvider } from '../lib/e2b-provider.js';

function provider() {
  return new E2bSandboxProvider({
    apiKey: 'test-key',
    template: 'desktop-template',
    idleTimeoutMs: 900_000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  e2b.create.mockResolvedValue(e2b.sandbox);
  e2b.connect.mockResolvedValue(e2b.sandbox);
  e2b.sandbox.isRunning.mockResolvedValue(true);
  e2b.sandbox.stream.getAuthKey.mockReturnValue('view-secret');
  e2b.sandbox.stream.getUrl.mockImplementation(
    (options) => `https://desktop.test/?viewOnly=${String(options.viewOnly)}`,
  );
});

describe('E2B computer provider', () => {
  it('provisions an idle-pausing persistent desktop', async () => {
    await expect(provider().provision({ computer_id: 'computer_default' })).resolves.toEqual({
      sandbox_id: 'sandbox-1',
    });
    expect(e2b.create).toHaveBeenCalledWith(
      'desktop-template',
      expect.objectContaining({
        apiKey: 'test-key',
        timeoutMs: 900_000,
        lifecycle: { onTimeout: { action: 'pause', keepMemory: true }, autoResume: false },
        metadata: {
          recursive_kind: 'shared-user-computer',
          recursive_computer_id: 'computer_default',
        },
      }),
    );
  });

  it('uses authenticated read-only and interactive live views', async () => {
    const instance = provider();
    await instance.provision({ computer_id: 'computer_default' });

    const readonly = await instance.liveViewUrl('sandbox-1');
    const interactive = await instance.liveViewUrl('sandbox-1', { interactive: true });

    expect(e2b.sandbox.stream.start).toHaveBeenCalledWith({ requireAuth: true });
    expect(e2b.sandbox.stream.getUrl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authKey: 'view-secret',
        viewOnly: true,
      }),
    );
    expect(e2b.sandbox.stream.getUrl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authKey: 'view-secret',
        viewOnly: false,
      }),
    );
    expect(readonly).toMatchObject({ interactive: false });
    expect(interactive).toMatchObject({ interactive: true });
    expect(e2b.sandbox.setTimeout).toHaveBeenCalledWith(900_000);
  });

  it('suspends with memory retained and destroys explicitly', async () => {
    const instance = provider();
    await instance.provision({ computer_id: 'computer_default' });

    await instance.stop('sandbox-1');
    await instance.destroy('sandbox-1');

    expect(e2b.sandbox.stream.stop).toHaveBeenCalledOnce();
    expect(e2b.sandbox.pause).toHaveBeenCalledWith({ keepMemory: true, apiKey: 'test-key' });
    expect(e2b.kill).toHaveBeenCalledWith('sandbox-1', { apiKey: 'test-key' });
  });
});
