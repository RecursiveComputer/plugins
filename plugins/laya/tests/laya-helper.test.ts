import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { LayaHelperClient, closeAllLayaHelperClients, getLayaHelperClient, helperKey } from '../lib/laya-helper.js';

const FAKE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-laya-helper.mjs');
const options = { pythonPath: process.execPath, helperPath: FAKE_HELPER };

afterEach(() => closeAllLayaHelperClients());

describe('LayaHelperClient', () => {
  it('round-trips JSON-lines requests through a persistent child', async () => {
    const client = new LayaHelperClient(options);
    const status = await client.request<{ ok: boolean; version: string }>('status', {}, 5_000);
    expect(status).toMatchObject({ ok: true, version: '0.3.3' });
    const second = await client.request<{ ok: boolean }>('status', {}, 5_000);
    expect(second.ok).toBe(true);
    client.close();
  });

  it('surfaces helper errors as rejections without dropping the process', async () => {
    const client = new LayaHelperClient(options);
    await expect(client.request('boom', {}, 5_000)).rejects.toThrow('kaboom');
    await expect(client.request('status', {}, 5_000)).resolves.toMatchObject({ ok: true });
    client.close();
  });

  it('times out a slow request but keeps the child alive for later calls', async () => {
    const client = new LayaHelperClient(options);
    await expect(client.request('slow', { delay_ms: 400 }, 50)).rejects.toThrow(/timed out/);
    await expect(client.request('status', {}, 5_000)).resolves.toMatchObject({ ok: true });
    client.close();
  });

  it('reports the child exit with the last stderr line', async () => {
    const client = new LayaHelperClient({ pythonPath: process.execPath, helperPath: '/nonexistent/helper.py' });
    await expect(client.request('status', {}, 5_000)).rejects.toThrow(/Cannot find module|helper stopped/);
  });

  it('forwards device and preload flags and keys the shared client on them', () => {
    const a = helperKey({ ...options, device: 'cpu', preload: true, maxLoaded: 3 });
    const b = helperKey({ ...options, device: 'auto' });
    expect(a).toContain('--device');
    expect(a).toContain('--preload');
    expect(a).toContain('--max-loaded');
    expect(b).not.toContain('--device');
    expect(getLayaHelperClient(options)).toBe(getLayaHelperClient(options));
    expect(getLayaHelperClient({ ...options, device: 'cpu' })).not.toBe(getLayaHelperClient(options));
  });
});
