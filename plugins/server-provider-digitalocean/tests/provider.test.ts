import { describe, expect, it, vi } from 'vitest';
import { createDigitalOceanProvider } from '../provider.js';

function api(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; auth: string | null }> = [];
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: `${url.pathname}${url.search}`, body: init?.body ? JSON.parse(String(init.body)) : null, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const reply = routes[`${method} ${url.pathname}`];
    if (reply instanceof Response) return reply;
    if (reply === undefined) return Response.json({ id: 'not_found', message: 'The resource you were accessing could not be found.' }, { status: 404 });
    if (reply === null) return new Response(null, { status: 204 });
    return Response.json(reply);
  });
  return { calls, fetch: fetchFake as unknown as typeof fetch };
}

const bootstrap = { image: 'img', env: { RECURSIVE_API_KEY: 'rsk_x' }, port: 12321, script: '#!/bin/sh\nset -eu\necho run-server\n' };

describe('digitalocean server provider', () => {
  it('lists available regions and general sizes with dollar prices, cheapest first', async () => {
    const { fetch } = api({
      'GET /v2/regions': { regions: [{ slug: 'nyc3', name: 'New York 3', available: true }, { slug: 'old1', name: 'Old', available: false }, { slug: 'fra1', name: 'Frankfurt 1', available: true }] },
      'GET /v2/sizes': {
        sizes: [
          { slug: 's-4vcpu-8gb', memory: 8192, vcpus: 4, disk: 160, price_monthly: 48, available: true, description: 'Basic' },
          { slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80, price_monthly: 24, available: true, description: 'Basic' },
          { slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, available: true, description: 'Basic' },
          { slug: 'gpu-h100x1-80gb', memory: 245760, vcpus: 20, disk: 720, price_monthly: 4500, available: true },
          { slug: 's-2vcpu-2gb', memory: 2048, vcpus: 2, disk: 60, price_monthly: 18, available: false },
        ],
      },
    });
    const offers = await createDigitalOceanProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null }).offers!();
    expect(offers.regions.map((region) => region.id)).toEqual(['nyc3', 'fra1']);
    expect(offers.sizes).toEqual([
      { id: 's-2vcpu-4gb', label: 'Basic s-2vcpu-4gb', detail: '2 vCPU · 4 GB · 80 GB disk', monthly_price: { amount: 24, currency: 'USD' }, recommended: true },
      { id: 's-4vcpu-8gb', label: 'Basic s-4vcpu-8gb', detail: '4 vCPU · 8 GB · 160 GB disk', monthly_price: { amount: 48, currency: 'USD' }, recommended: false },
    ]);
  });

  it('tags a closed firewall onto the Droplet before it boots, then joins the tailnet', async () => {
    const { fetch, calls } = api({
      'POST /v2/tags': { tag: { name: 'recursive-abc123' } },
      'POST /v2/firewalls': { firewall: { id: 'fw-1' } },
      'POST /v2/droplets': { droplet: { id: 123, name: 'recursive-abc123', status: 'new' } },
      'GET /v2/droplets/123': { droplet: { id: 123, name: 'recursive-abc123', status: 'active' } },
    });
    const provider = createDigitalOceanProvider({ apiToken: 'secret-token', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => 'tail1234.ts.net' });
    const created = await provider.create({ server_id: 'srv_abc123', name: 'Studio', region: 'fra1', size: 's-2vcpu-4gb', bootstrap });
    expect(created).toEqual({ instance_id: '123:fw-1', url: 'http://recursive-abc123.tail1234.ts.net:12321' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /v2/tags', 'POST /v2/firewalls', 'POST /v2/droplets']);
    expect(calls[1]).toMatchObject({ auth: 'Bearer secret-token', body: { tags: ['recursive-abc123'], inbound_rules: [] } });
    const droplet = calls[2]!.body!;
    expect(droplet).toMatchObject({ name: 'recursive-abc123', region: 'fra1', size: 's-2vcpu-4gb', image: 'ubuntu-24-04-x64', tags: ['recursive-abc123'] });
    expect(droplet.user_data).toContain("tailscale up --auth-key='tskey-auth-abc' --hostname='recursive-abc123'");
    expect(String(droplet.user_data).indexOf('tailscale up')).toBeLessThan(String(droplet.user_data).indexOf('run-server'));
    expect(await provider.status('123:fw-1')).toEqual({ state: 'running', url: 'http://recursive-abc123.tail1234.ts.net:12321' });
  });

  it('removes the firewall and tag when the Droplet cannot be created', async () => {
    const { fetch, calls } = api({
      'POST /v2/tags': { tag: { name: 'recursive-1' } },
      'POST /v2/firewalls': { firewall: { id: 'fw-1' } },
      'POST /v2/droplets': Response.json({ id: 'forbidden', message: 'droplet limit reached' }, { status: 422 }),
      'DELETE /v2/firewalls/fw-1': null,
      'DELETE /v2/tags/recursive-1': null,
    });
    const provider = createDigitalOceanProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null });
    await expect(provider.create({ server_id: 'srv_1', name: 'x', bootstrap })).rejects.toThrow('droplet limit reached');
    expect(calls.slice(-2).map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /v2/firewalls/fw-1', 'DELETE /v2/tags/recursive-1']);
  });

  it('reads off as paused, a missing Droplet as gone, and tears down Droplet, firewall and tag', async () => {
    const { fetch, calls } = api({
      'GET /v2/droplets/123': { droplet: { id: 123, name: 'recursive-abc', status: 'off' } },
      'DELETE /v2/droplets/123': null,
      'DELETE /v2/firewalls/fw-1': null,
      'DELETE /v2/tags/recursive-abc': null,
    });
    const provider = createDigitalOceanProvider({ apiToken: 't', tailscaleAuthKey: 'tskey-auth-abc' }, { fetch, tailnetSuffix: async () => null });
    expect(await provider.status('123:fw-1')).toEqual({ state: 'stopped', url: 'http://recursive-abc:12321' });
    expect(await provider.status('999:fw-1')).toEqual({ state: 'not_found' });
    await provider.destroy('123:fw-1');
    expect(calls.slice(-3).map((call) => `${call.method} ${call.path}`)).toEqual(['DELETE /v2/droplets/123', 'DELETE /v2/firewalls/fw-1', 'DELETE /v2/tags/recursive-abc']);
  });
});
