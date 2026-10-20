import { describe, expect, it, vi } from 'vitest';
import { createSshServerProvider, HOST_STORAGE_SCRIPT, parseHostStorage } from '../provider.js';

const settings = { host: 'box.tail1234.ts.net', user: 'root', port: 22, identityFile: '', address: '' };

describe('ssh server provider', () => {
  it('sends the install script on stdin, never in the remote command', async () => {
    const ssh = vi.fn(async () => '');
    const provider = createSshServerProvider(settings, ssh);
    const created = await provider.create({ server_id: 'srv_1', name: 'x', bootstrap: { image: 'img', env: { RECURSIVE_API_KEY: 'rsk_secret' }, port: 12321, script: 'RECURSIVE_API_KEY=rsk_secret' } });
    expect(created.url).toBe('http://box.tail1234.ts.net:12321');
    const [args, stdin] = ssh.mock.calls[0]! as unknown as [string[], string];
    expect(args).toEqual(['RECURSIVE_PUBLISH=0.0.0.0', 'RECURSIVE_PRUNE_BUILD_CACHE=0', 'sh', '-s']);
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

  describe('Docker on the host', () => {
    const id = (n: number) => `sha256:${String(n).repeat(64)}`;
    const REPO = 'ghcr.io/jackbogdan/recursive-server';
    const entry = '["/usr/bin/tini","--","/opt/recursive/entrypoint.sh"]';
    const listing = [
      '@containers',
      `${id(1)} /recursive-server`,
      `${id(9)} /postgres`,
      '@images',
      `"${id(1)}" 1500000000 "2026-10-19T10:00:00Z" ["${REPO}:sha-new","${REPO}:stable"] ["${REPO}@sha256:aa"] ${entry}`,
      `"${id(2)}" 1400000000 "2026-10-18T10:00:00Z" ["${REPO}:sha-old"] [] ${entry}`,
      `"${id(3)}" 1300000000 "2026-10-17T10:00:00Z" [] ["${REPO}@sha256:bb"] ${entry}`,
      `"${id(4)}" 1200000000 "2026-10-16T10:00:00Z" [] [] ${entry}`,
      `"${id(5)}" 90000000 "2026-10-16T10:00:00Z" ["localhost:5000/recursive-runner:v2"] [] null`,
      `"${id(6)}" 400000000 "2026-10-01T10:00:00Z" ["postgres:16"] ["postgres@sha256:cc"] ["docker-entrypoint.sh"]`,
      `"${id(7)}" 100000000 "2026-10-01T10:00:00Z" [] [] null`,
      `"${id(8)}" 100000000 "2026-10-01T10:00:00Z" ["${REPO}:mine","myapp:latest"] [] ${entry}`,
      '@df',
      JSON.stringify({
        Images: [{ Id: id(1), Size: 1500000000, SharedSize: 1000000000 }, { Id: id(2), Size: 1400000000, SharedSize: -1 }],
        BuildCache: [{ Size: 2000000000, InUse: false, Shared: false }, { Size: 500000000, InUse: true, Shared: false }, { Size: 900000000, InUse: false, Shared: true }],
      }),
      '@buildx',
      '',
    ].join('\n');

    it('lists only Recursive images, with the containers that use them and the build cache', () => {
      const storage = parseHostStorage(listing);
      expect(storage.images.map((image) => [image.id, image.repository, image.tags, image.bytes, image.containers])).toEqual([
        [id(1), REPO, [`${REPO}:sha-new`, `${REPO}:stable`], 500000000, ['recursive-server']],
        [id(2), REPO, [`${REPO}:sha-old`], 1400000000, []],
        [id(3), REPO, [], 1300000000, []],
        [id(4), null, [], 1200000000, []],
        [id(5), 'localhost:5000/recursive-runner', ['localhost:5000/recursive-runner:v2'], 90000000, []],
      ]);
      expect(storage.images[0]!.created_ms).toBe(Date.parse('2026-10-19T10:00:00Z'));
      expect(storage.build_cache).toEqual({ bytes: 2500000000, reclaimable_bytes: 2000000000 });
    });

    it('falls back to buildx for the build cache where curl is missing', () => {
      const storage = parseHostStorage(['@images', '@df', '', '@buildx', 'Shared:\t\t0B', 'Private:\t3.1GB', 'Reclaimable:\t2.6GB', 'Total:\t\t3.1GB'].join('\n'));
      expect(storage.build_cache).toEqual({ bytes: 3100000000, reclaimable_bytes: 2600000000 });
      expect(parseHostStorage('@images\n@df\n\n@buildx\n').build_cache).toBeNull();
    });

    it('reads the host in one read-only script on stdin', async () => {
      const ssh = vi.fn(async () => listing);
      await createSshServerProvider(settings, ssh).hostStorage('i');
      expect(ssh).toHaveBeenCalledWith(['sh', '-s'], HOST_STORAGE_SCRIPT);
      expect(HOST_STORAGE_SCRIPT).not.toMatch(/\b(rm|rmi|prune|volume|stop|kill)\b/);
    });

    it('removes only listed images that are still Recursive and unused, by their tags', async () => {
      const commands: string[][] = [];
      const ssh = vi.fn(async (args: string[]) => {
        commands.push(args);
        if (args[0] === 'sh') return listing;
        if (args.includes('prune')) return 'ID\nTotal:\t1.2GB';
        return '';
      });
      const result = await createSshServerProvider(settings, ssh).reclaimHostStorage('i', {
        image_ids: [id(1), id(2), id(4), id(6), id(8), 'sha256:nothing'],
        build_cache_keep_bytes: 2 * 1024 ** 3,
      });
      expect(result.removed).toEqual([id(2), id(4)]);
      expect(result.failed.map((failure) => failure.id)).toEqual([id(1), id(6), id(8), 'sha256:nothing']);
      expect(result.failed[0]!.error).toContain('recursive-server');
      expect(result.build_cache_freed_bytes).toBe(1200000000);
      const writes = commands.filter((args) => args[0] !== 'sh');
      expect(writes).toEqual([
        ['docker', 'image', 'rm', `${REPO}:sha-old`],
        ['docker', 'image', 'rm', id(4)],
        ['docker', 'builder', 'prune', '-f', '--keep-storage', String(2 * 1024 ** 3)],
      ]);
      expect(writes.flat().join(' ')).not.toMatch(/postgres|myapp|volume|--force|\s-f\s.*rm/);
    });

    it('leaves the build cache alone unless the plan prunes it, and retries the prune with its newer flag', async () => {
      const calls: string[][] = [];
      const ssh = vi.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'sh') return listing;
        if (args.includes('--keep-storage')) throw new Error('unknown flag: --keep-storage');
        return 'Total:\t0B';
      });
      const provider = createSshServerProvider(settings, ssh);
      expect((await provider.reclaimHostStorage('i', { image_ids: [], build_cache_keep_bytes: null })).build_cache_freed_bytes).toBeNull();
      expect(calls.some((args) => args.includes('prune'))).toBe(false);
      await provider.reclaimHostStorage('i', { image_ids: [], build_cache_keep_bytes: 1024 });
      expect(calls.at(-1)).toEqual(['docker', 'builder', 'prune', '-f', '--reserved-space', '1024']);
    });
  });

  it('removes the container an update replaced before the data volume it still mounts', async () => {
    const ssh = vi.fn(async () => '');
    await createSshServerProvider(settings, ssh).destroy('i');
    const script = (ssh.mock.calls[0] as unknown as [string[]])[0].join(' ');
    const prev = script.indexOf('docker rm -f recursive-server-prev');
    expect(script).toContain('docker rm -f recursive-server ');
    expect(prev).toBeGreaterThan(-1);
    expect(prev).toBeLessThan(script.indexOf('docker volume rm recursive-data'));
  });
});
