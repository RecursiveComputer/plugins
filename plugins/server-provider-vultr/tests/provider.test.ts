import { describe, expect, it, vi } from 'vitest';
import { createVultrProvider } from '../provider.js';

function api(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const reply = routes[`${method} ${url.pathname}`];
    if (reply instanceof Response) return reply;
    if (reply === undefined) return Response.json({ error: 'Invalid instance-id.', status: 404 }, { status: 404 });
    if (reply === null) return new Response(null, { status: 204 });
    return Response.json(reply);
  });
  return { calls, fetch: fetchFake as unknown as typeof fetch };
}

const bootstrap = { image: 'img', env: { RECURSIVE_API_KEY: 'rsk_x' }, port: 12321, script: '#!/bin/sh\nset -eu\necho run-server\n' };

describe('vultr server provider', () => {
  it('lists regions and plans of 2 GB or more with dollar prices, cheapest first', async () => {
    const { fetch } = api({
      'GET /v2/regions': { regions: [{ id: 'ewr', city: 'New Jersey', country: 'US' }, { id: 'fra', city: 'Frankfurt', country: 'DE' }] },
      'GET /v2/plans': {
        plans: [
          { id: 'vc2-4c-8gb', vcpu_count: 4, ram: 8192, disk: 160, monthly_cost: 40, locations: ['ewr'] },
          { id: 'vc2-2c-4gb', vcpu_count: 2, ram: 4096, disk: 80, monthly_cost: 20, locations: ['ewr', 'fra'] },
          { id: 'vc2-1c-1gb', vcpu_count: 1, ram: 1024, disk: 25, monthly_cost: 5, locations: ['ewr'] },
          { id: 'vc2-2c-2gb-gone', vcpu_count: 2, ram: 2048, disk: 55, monthly_cost: 15, locations: [] },
        ],
      },
    });
    const offers = await createVultrProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null }).offers!();
    expect(offers.regions).toEqual([
      { id: 'ewr', label: 'New Jersey, US', recommended: true },
      { id: 'fra', label: 'Frankfurt, DE', recommended: false },
    ]);
    expect(offers.sizes.map((size) => [size.id, size.monthly_price?.amount, size.recommended])).toEqual([
      ['vc2-2c-4gb', 20, true],
      ['vc2-4c-8gb', 40, false],
    ]);
  });

  it('creates a rule-less firewall group and an Ubuntu server that joins the tailnet', async () => {
    const { fetch, calls } = api({
      'POST /v2/firewalls': { firewall_group: { id: 'fg-1' } },
      'GET /v2/os': { os: [{ id: 1743, name: 'Ubuntu 22.04 LTS x64' }, { id: 2284, name: 'Ubuntu 24.04 LTS x64' }] },
      'POST /v2/instances': { instance: { id: 'inst-1', label: 'recursive-abc123', status: 'pending', power_status: 'running', server_status: 'none' } },
      'GET /v2/instances/inst-1': { instance: { id: 'inst-1', label: 'recursive-abc123', status: 'active', power_status: 'running', server_status: 'ok' } },
    });
    const provider = createVultrProvider({ apiToken: 'secret-key', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => 'tail1234.ts.net' });
    const created = await provider.create({ server_id: 'srv_abc123', name: 'Studio', region: 'fra', size: 'vc2-2c-4gb', bootstrap });
    expect(created).toEqual({ instance_id: 'inst-1:fg-1', url: 'http://recursive-abc123.tail1234.ts.net:12321' });
    const instance = calls.find((call) => call.method === 'POST' && call.path === '/v2/instances')!;
    expect(instance).toMatchObject({ auth: 'Bearer secret-key', body: { region: 'fra', plan: 'vc2-2c-4gb', os_id: 2284, label: 'recursive-abc123', firewall_group_id: 'fg-1' } });
    const userData = Buffer.from(String(instance.body!.user_data), 'base64').toString('utf8');
    expect(userData).toContain("tailscale up --auth-key='tskey-auth-abc' --hostname='recursive-abc123'");
    expect(userData.indexOf('tailscale up')).toBeLessThan(userData.indexOf('run-server'));
    expect(await provider.status('inst-1:fg-1')).toEqual({ state: 'running', url: 'http://recursive-abc123.tail1234.ts.net:12321' });
  });

  it('removes the firewall group when the server cannot be created', async () => {
    const { fetch, calls } = api({
      'POST /v2/firewalls': { firewall_group: { id: 'fg-1' } },
      'GET /v2/os': { os: [] },
      'POST /v2/instances': Response.json({ error: 'Instance limit reached', status: 400 }, { status: 400 }),
      'DELETE /v2/firewalls/fg-1': null,
    });
    const provider = createVultrProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null });
    await expect(provider.create({ server_id: 'srv_1', name: 'x', bootstrap })).rejects.toThrow('Instance limit reached');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v2/firewalls/fg-1' });
  });

  it('reads a halted server as paused and a missing one as gone', async () => {
    const { fetch } = api({
      'GET /v2/instances/inst-1': { instance: { id: 'inst-1', label: 'recursive-abc', status: 'active', power_status: 'stopped', server_status: 'ok' } },
    });
    const provider = createVultrProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null });
    expect(await provider.status('inst-1:fg-1')).toEqual({ state: 'stopped', url: 'http://recursive-abc:12321' });
    expect(await provider.status('inst-2:fg-1')).toEqual({ state: 'not_found' });
  });
});
