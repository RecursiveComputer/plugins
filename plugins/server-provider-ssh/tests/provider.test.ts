import { describe, expect, it, vi } from 'vitest';
import { createSshServerProvider } from '../provider.js';

const settings = { host: 'box.tail1234.ts.net', user: 'root', port: 22, identityFile: '', address: '' };

describe('ssh server provider', () => {
  it('sends the install script on stdin, never in the remote command', async () => {
    const ssh = vi.fn(async () => '');
    const provider = createSshServerProvider(settings, ssh);
    const created = await provider.create({ server_id: 'srv_1', name: 'x', bootstrap: { image: 'img', env: { RECURSIVE_API_KEY: 'rsk_secret' }, port: 12321, script: 'RECURSIVE_API_KEY=rsk_secret' } });
    expect(created.url).toBe('http://box.tail1234.ts.net:12321');
    const [args, stdin] = ssh.mock.calls[0]! as unknown as [string[], string];
    expect(args).toEqual(['RECURSIVE_PUBLISH=0.0.0.0', 'sh', '-s']);
    expect(args.join(' ')).not.toContain('rsk_secret');
    expect(stdin).toContain('rsk_secret');
  });

  it('publishes only on the address you reach it at', async () => {
    const ssh = vi.fn(async () => 'running');
    const provider = createSshServerProvider({ ...settings, address: 'http://100.101.102.103:12321' }, ssh);
    await provider.create({ server_id: 'srv_1', name: 'x', bootstrap: { image: 'img', env: {}, port: 12321, script: '' } });
    expect((ssh.mock.calls[0] as unknown as [string[]])[0][0]).toBe('RECURSIVE_PUBLISH=100.101.102.103');
    expect(await provider.status('i')).toEqual({ state: 'running', url: 'http://100.101.102.103:12321' });
  });
});
