import { describe, expect, it, vi, type Mock } from 'vitest';
import { createHetznerProvider, hetznerUserData, tailnetHostname } from '../provider.js';

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
