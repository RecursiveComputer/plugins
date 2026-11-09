import { describe, expect, it, vi, type Mock } from 'vitest';
import { createHetznerProvider, hetznerUserData, hetznerVolumeName, tailnetHostname } from '../provider.js';

function api(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const reply = routes[`${method} ${url.pathname}`];
    if (reply instanceof Response) return reply;
    if (reply === undefined) return Response.json({ error: { message: 'not found' } }, { status: 404 });
    return Response.json(reply);
  });
  return { calls, fetch: fetchFake as unknown as typeof fetch };
}

const bootstrap = { image: 'img', env: { RECURSIVE_API_KEY: 'rsk_x' }, port: 12321, script: '#!/bin/sh\nset -eu\necho run-server\n' };

describe('hetzner server provider', () => {
  it('lists regions and x86 sizes with euro prices, cheapest first', async () => {
    const { fetch } = api({
      'GET /v1/locations': { locations: [{ name: 'fsn1', description: 'Falkenstein', city: 'Falkenstein', country: 'DE' }, { name: 'ash', description: 'Ashburn', city: 'Ashburn', country: 'US' }] },
      'GET /v1/server_types': {
        server_types: [
          { name: 'cx32', description: '', cores: 4, memory: 8, disk: 80, deprecated: false, architecture: 'x86', prices: [{ location: 'fsn1', price_monthly: { gross: '7.4900' } }] },
          { name: 'cx22', description: '', cores: 2, memory: 4, disk: 40, deprecated: false, architecture: 'x86', prices: [{ location: 'fsn1', price_monthly: { gross: '4.5900' } }, { location: 'ash', price_monthly: { gross: '5.2000' } }] },
          { name: 'cax11', description: '', cores: 2, memory: 4, disk: 40, deprecated: false, architecture: 'arm', prices: [] },
          { name: 'cx11', description: '', cores: 1, memory: 2, disk: 20, deprecated: true, architecture: 'x86', prices: [] },
        ],
      },
    });
    const offers = await createHetznerProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null }).offers!();
    expect(offers.regions.map((region) => region.id)).toEqual(['fsn1', 'ash']);
    expect(offers.sizes).toEqual([
      { id: 'cx22', label: 'CX22', detail: '2 vCPU · 4 GB · 40 GB disk', monthly_price: { amount: 4.59, currency: 'EUR' }, recommended: true },
      { id: 'cx32', label: 'CX32', detail: '4 vCPU · 8 GB · 80 GB disk', monthly_price: { amount: 7.49, currency: 'EUR' }, recommended: false },
    ]);
  });

  it('creates a closed firewall and a server that joins the tailnet, reachable by its tailnet name', async () => {
    const { fetch, calls } = api({
      'POST /v1/firewalls': { firewall: { id: 77 } },
      'POST /v1/servers': { server: { id: 123 } },
      'GET /v1/servers/123': { server: { status: 'running', labels: { 'recursive-server': 'srv_abc123' } } },
    });
    const provider = createHetznerProvider({ apiToken: 'secret-token', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => 'tail1234.ts.net' });
    const created = await provider.create({ server_id: 'srv_abc123', name: 'Studio', region: 'fsn1', size: 'cx22', bootstrap });
    expect(created).toEqual({ instance_id: '123:77', url: 'http://recursive-abc123.tail1234.ts.net:12321' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/firewalls', auth: 'Bearer secret-token', body: { rules: [] } });
    const server = calls[1]!.body!;
    expect(server).toMatchObject({ name: 'recursive-abc123', server_type: 'cx22', location: 'fsn1', image: 'ubuntu-24.04', firewalls: [{ firewall: 77 }], labels: { 'recursive-server': 'srv_abc123' } });
    expect(server.user_data).toContain("tailscale up --auth-key='tskey-auth-abc' --hostname='recursive-abc123'");
    expect(server.user_data).toContain('RECURSIVE_PUBLISH="$(tailscale ip -4)"');
    expect(String(server.user_data).indexOf('tailscale up')).toBeLessThan(String(server.user_data).indexOf('run-server'));
    expect(await provider.status('123:77')).toEqual({ state: 'running', url: 'http://recursive-abc123.tail1234.ts.net:12321' });
  });

  it('cleans up the firewall when the server cannot be created', async () => {
    const { fetch, calls } = api({
      'POST /v1/firewalls': { firewall: { id: 77 } },
      'POST /v1/servers': Response.json({ error: { message: 'server limit reached' } }, { status: 403 }),
      'DELETE /v1/firewalls/77': {},
    });
    const provider = createHetznerProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null });
    await expect(provider.create({ server_id: 'srv_1', name: 'x', bootstrap })).rejects.toThrow('server limit reached');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/firewalls/77' });
  });

  it('refuses a malformed auth key rather than writing it into a script', () => {
    expect(() => hetznerUserData('#!/bin/sh\n', "tskey-auth-x' ; curl evil", 'h')).toThrow(/malformed/);
    expect(tailnetHostname('srv_ABC_12')).toBe('recursive-abc-12');
  });
  it('resizes a running server: shuts it down, changes the type with a bigger disk, and powers it on', async () => {
    let status = 'running';
    let polls = 0;
    const { fetch, calls } = api({});
    const routes = fetch as unknown as Mock<typeof fetch>;
    const inner = routes.getMockImplementation()!;
    routes.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path === '/v1/servers/123') {
        await inner(input, init);
        return Response.json({ server: { status } });
      }
      if (path === '/v1/servers/123/actions/shutdown') { await inner(input, init); status = 'off'; return Response.json({ action: { id: 1, command: 'shutdown_server', status: 'running' } }); }
      if (path === '/v1/servers/123/actions/change_type') { await inner(input, init); return Response.json({ action: { id: 2, command: 'change_server_type', status: 'running' } }); }
      if (path === '/v1/actions/2') { await inner(input, init); polls += 1; return Response.json({ action: { id: 2, command: 'change_server_type', status: polls > 1 ? 'success' : 'running' } }); }
      if (path === '/v1/servers/123/actions/poweron') { await inner(input, init); status = 'running'; return Response.json({ action: { id: 3, command: 'start_server', status: 'running' } }); }
      return inner(input, init);
    });
    const provider = createHetznerProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null, sleep: async () => undefined });
    await provider.resize('123:77', 'cx33');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/servers/123',
      'POST /v1/servers/123/actions/shutdown',
      'GET /v1/servers/123',
      'POST /v1/servers/123/actions/change_type',
      'GET /v1/actions/2',
      'GET /v1/actions/2',
      'POST /v1/servers/123/actions/poweron',
    ]);
    expect(calls[3]!.body).toEqual({ server_type: 'cx33', upgrade_disk: true });
  });

  it('powers the server back on when Hetzner refuses the new size', async () => {
    const { fetch, calls } = api({
      'GET /v1/servers/123': { server: { status: 'off' } },
      'POST /v1/servers/123/actions/change_type': { action: { id: 2, command: 'change_server_type', status: 'error', error: { message: 'server type not available' } } },
      'POST /v1/servers/123/actions/poweron': { action: { id: 3, command: 'start_server', status: 'running' } },
    });
    const provider = createHetznerProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null, sleep: async () => undefined });
    await expect(provider.resize('123:77', 'cx99')).rejects.toThrow('Hetzner: server type not available');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/servers/123/actions/poweron' });
  });
});

describe('hetzner volumes', () => {
  const done = (id: number, command: string) => ({ id, command, status: 'success' });
  const vol = (over: Record<string, unknown> = {}) => ({ id: 55, name: 'recursive-w-abc', size: 100, server: 123, linux_device: '/dev/disk/by-id/scsi-0HC_Volume_55', status: 'available', location: { name: 'fsn1' }, ...over });
  const provider = (fetcher: typeof globalThis.fetch) => createHetznerProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch: fetcher, tailnetSuffix: async () => null, sleep: async () => undefined }).volumes;

  it('creates an ext4 volume on the server without automount, and waits for it to attach', async () => {
    const { fetch, calls } = api({
      'POST /v1/volumes': { volume: vol({ status: 'creating' }), action: done(1, 'create_volume'), next_actions: [{ id: 2, command: 'attach_volume', status: 'running' }] },
      'GET /v1/actions/2': { action: done(2, 'attach_volume') },
      'GET /v1/volumes/55': { volume: vol() },
    });
    const created = await provider(fetch).create({ instance_id: '123:77', name: 'Recursive W_ABC', size_gb: 100, labels: { 'recursive-workspace': 'w_abc' } });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/volumes', body: { name: 'recursive-w-abc', size: 100, server: 123, automount: false, format: 'ext4', labels: { 'recursive-workspace': 'w_abc' } } });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /v1/volumes', 'GET /v1/actions/2', 'GET /v1/volumes/55']);
    expect(created).toEqual({ volume_id: '55', name: 'recursive-w-abc', size_gb: 100, location: 'fsn1', attached_to: '123', device: '/dev/disk/by-id/scsi-0HC_Volume_55', state: 'available' });
  });

  it('refuses sizes Hetzner does not sell before calling it', async () => {
    const { fetch, calls } = api({});
    await expect(provider(fetch).create({ instance_id: '123:77', name: 'w', size_gb: 5 })).rejects.toThrow('10 to 10240 GB');
    await expect(provider(fetch).create({ instance_id: '123:77', name: 'w', size_gb: 20.5 })).rejects.toThrow('whole GB');
    expect(calls).toEqual([]);
  });

  it('grows a volume, never shrinks it, and does nothing at the same size', async () => {
    let size = 100;
    const { fetch, calls } = api({});
    const inner = fetch as unknown as Mock;
    const grow = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      await inner(input, init);
      if (path === '/v1/volumes/55') return Response.json({ volume: vol({ size }) });
      if (path === '/v1/volumes/55/actions/resize') { size = JSON.parse(String(init?.body)).size; return Response.json({ action: done(3, 'resize_volume') }); }
      return Response.json({ error: { message: 'not found' } }, { status: 404 });
    }) as unknown as typeof fetch;
    const volumes = provider(grow);
    expect((await volumes.grow('55', 150)).size_gb).toBe(150);
    expect(calls.find((call) => call.path === '/v1/volumes/55/actions/resize')?.body).toEqual({ size: 150 });
    await expect(volumes.grow('55', 120)).rejects.toThrow('cannot shrink: it is 150 GB');
    const before = calls.length;
    expect((await volumes.grow('55', 150)).size_gb).toBe(150);
    expect(calls.slice(before).map((call) => call.method)).toEqual(['GET']);
  });

  it('attaches only a free volume, and detaches before it can be deleted', async () => {
    const { fetch: attachedElsewhere } = api({ 'GET /v1/volumes/55': { volume: vol({ server: 999 }) } });
    await expect(provider(attachedElsewhere).attach('55', '123:77')).rejects.toThrow('attached to another server (999)');
    await expect(provider(attachedElsewhere).remove('55')).rejects.toThrow('Detach the volume');

    let server: number | null = null;
    const { fetch, calls } = api({});
    const inner = fetch as unknown as Mock;
    const moving = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      await inner(input, init);
      if (path === '/v1/volumes/55' && (init?.method ?? 'GET') === 'GET') return Response.json({ volume: vol({ server }) });
      if (path === '/v1/volumes/55/actions/attach') { server = JSON.parse(String(init?.body)).server; return Response.json({ action: done(4, 'attach_volume') }); }
      if (path === '/v1/volumes/55/actions/detach') { server = null; return Response.json({ action: done(5, 'detach_volume') }); }
      if (path === '/v1/volumes/55' && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ error: { message: 'not found' } }, { status: 404 });
    }) as unknown as typeof fetch;
    const volumes = provider(moving);
    expect((await volumes.attach('55', '123:77')).attached_to).toBe('123');
    expect(calls.find((call) => call.path === '/v1/volumes/55/actions/attach')?.body).toEqual({ server: 123, automount: false });
    expect((await volumes.detach('55')).attached_to).toBeNull();
    await volumes.remove('55');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/volumes/55' });
  });

  it('answers null for a volume that is gone', async () => {
    const { fetch } = api({});
    expect(await provider(fetch).get('404')).toBeNull();
    await expect(provider(fetch).remove('404')).resolves.toBeUndefined();
  });

  it('names volumes the way Hetzner accepts', () => {
    expect(hetznerVolumeName('Future In Detail w_b9f0b1fb')).toBe('future-in-detail-w-b9f0b1fb');
    expect(() => hetznerVolumeName('!!!')).toThrow('needs a name');
  });
});
