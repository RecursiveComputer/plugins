import { describe, expect, it, vi } from 'vitest';
import { createDockerServerProvider } from '../provider.js';

describe('docker server provider', () => {
  it('runs the image with a volume, publishes only on loopback, and passes secrets by name', async () => {
    const docker = vi.fn(async (args: string[]) => (args[0] === 'run' ? 'abc123' : ''));
    const provider = createDockerServerProvider(docker, async () => 45678);
    const created = await provider.create({
      server_id: 'srv_1',
      name: 'x',
      bootstrap: { image: 'recursive-server:local', env: { RECURSIVE_API_KEY: 'rsk_secret' }, port: 12321, script: '' },
    });
    expect(created).toEqual({ instance_id: 'abc123', url: 'http://127.0.0.1:45678' });
    const [args, env] = docker.mock.calls[0]! as unknown as [string[], Record<string, string>];
    expect(args).toContain('127.0.0.1:45678:12321');
    expect(args).toContain('recursive-srv_1-data:/data');
    expect(args).toContain('RECURSIVE_API_KEY');
    expect(args.join(' ')).not.toContain('rsk_secret');
    expect(env).toEqual({ RECURSIVE_API_KEY: 'rsk_secret' });
  });
});
