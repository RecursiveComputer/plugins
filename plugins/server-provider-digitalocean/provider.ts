import { execFile } from 'node:child_process';
import {
  type ServerOffers,
  type ServerProvider,
  type ServerProviderPluginContext,
  type ServerProviderPluginModule,
  serverTailnetHostname,
  tailnetUserData,
} from '@recursivecomputer/plugin-sdk';

const API = 'https://api.digitalocean.com/v2';
const IMAGE = 'ubuntu-24-04-x64';

interface DigitalOceanSettings {
  apiToken: string;
  tailscaleAuthKey: string;
}

export interface DigitalOceanDeps {
  fetch: typeof fetch;
  /** MagicDNS suffix of this computer's tailnet (e.g. tail1234.ts.net), when Tailscale runs here. */
  tailnetSuffix(): Promise<string | null>;
}

function settingsFrom(context: ServerProviderPluginContext): DigitalOceanSettings {
  const raw = context.settings;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
  return { apiToken: text('apiToken'), tailscaleAuthKey: text('tailscaleAuthKey') };
}

function localTailnetSuffix(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const suffix = (JSON.parse(stdout) as { MagicDNSSuffix?: string }).MagicDNSSuffix;
        resolve(suffix ? suffix.replace(/\.$/, '') : null);
      } catch {
        resolve(null);
      }
    });
  });
}

interface Droplet {
  id: number;
  name: string;
  status: 'new' | 'active' | 'off' | 'archive';
}

/** The resource is gone (deleted here or in the provider's console). */
function isMissing(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

export function createDigitalOceanProvider(settings: DigitalOceanSettings, deps: DigitalOceanDeps = { fetch, tailnetSuffix: localTailnetSuffix }): ServerProvider {
  async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await deps.fetch(`${API}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return {} as T;
    const body = (await response.json().catch(() => ({}))) as { message?: string } & T;
    if (!response.ok) throw Object.assign(new Error(`DigitalOcean: ${body.message ?? `HTTP ${response.status}`}`), { status: response.status });
    return body;
  }

  async function url(hostname: string): Promise<string> {
    const suffix = await deps.tailnetSuffix();
    return `http://${suffix ? `${hostname}.${suffix}` : hostname}:12321`;
  }

  async function ignoreMissing(work: Promise<unknown>): Promise<void> {
    await work.catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }

  return {
    provider_id: 'digitalocean',
    async offers(): Promise<ServerOffers> {
      const [{ regions }, { sizes }] = await Promise.all([
        api<{ regions: Array<{ slug: string; name: string; available: boolean }> }>('/regions?per_page=200'),
        api<{ sizes: Array<{ slug: string; memory: number; vcpus: number; disk: number; price_monthly: number; available: boolean; description?: string }> }>('/sizes?per_page=200'),
      ]);
      // Basic and general-purpose Droplets; GPU and storage-heavy sizes are not what Recursive needs.
      const listed = sizes
        .filter((size) => size.available && size.memory >= 2048 && /^(s|c|g|m)-/.test(size.slug) && !/gpu/i.test(size.slug))
        .map((size) => ({
          id: size.slug,
          label: size.description ? `${size.description} ${size.slug}` : size.slug,
          detail: `${size.vcpus} vCPU · ${size.memory / 1024} GB · ${size.disk} GB disk`,
          monthly_price: { amount: size.price_monthly, currency: 'USD' },
        }))
        .sort((a, b) => a.monthly_price.amount - b.monthly_price.amount)
        .slice(0, 12);
      // The cheapest size with at least 4 GB runs Recursive and an agent comfortably.
      const recommended = listed.find((size) => /· (4|8) GB/.test(size.detail));
      return {
        regions: regions.filter((region) => region.available).map((region, index) => ({ id: region.slug, label: region.name, recommended: index === 0 })),
        sizes: listed.map((size) => ({ ...size, recommended: size === recommended })),
      };
    },
    async create({ server_id, region, size, bootstrap }) {
      if (!settings.tailscaleAuthKey) throw new Error('Add a Tailscale auth key in DigitalOcean Server settings first.');
      const hostname = serverTailnetHostname(server_id);
      // The tag ties the firewall to the Droplet before it boots, so it is never open.
      await api('/tags', { method: 'POST', body: JSON.stringify({ name: hostname }) }).catch((error) => {
        if (!/already exists/i.test(String(error))) throw error;
      });
      // Cloud firewalls deny by default both ways: no inbound rules, and outbound open so Tailscale and Docker work.
      const everywhere = { addresses: ['0.0.0.0/0', '::/0'] };
      const { firewall } = await api<{ firewall: { id: string } }>('/firewalls', {
        method: 'POST',
        body: JSON.stringify({
          name: `${hostname}-closed`,
          tags: [hostname],
          inbound_rules: [],
          outbound_rules: [
            { protocol: 'tcp', ports: '0', destinations: everywhere },
            { protocol: 'udp', ports: '0', destinations: everywhere },
            { protocol: 'icmp', destinations: everywhere },
          ],
        }),
      });
      try {
        const { droplet } = await api<{ droplet: Droplet }>('/droplets', {
          method: 'POST',
          body: JSON.stringify({
            name: hostname,
            region: region || 'nyc3',
            size: size || 's-2vcpu-4gb',
            image: IMAGE,
            user_data: tailnetUserData(bootstrap.script, settings.tailscaleAuthKey, hostname),
            tags: [hostname],
            monitoring: true,
          }),
        });
        return { instance_id: `${droplet.id}:${firewall.id}`, url: await url(hostname) };
      } catch (error) {
        await api(`/firewalls/${firewall.id}`, { method: 'DELETE' }).catch(() => undefined);
        await api(`/tags/${hostname}`, { method: 'DELETE' }).catch(() => undefined);
        throw error;
      }
    },
    async status(instanceId) {
      const [dropletId] = instanceId.split(':');
      try {
        const { droplet } = await api<{ droplet: Droplet }>(`/droplets/${dropletId}`);
        const address = await url(droplet.name);
        if (droplet.status === 'active') return { state: 'running', url: address };
        if (droplet.status === 'off' || droplet.status === 'archive') return { state: 'stopped', url: address };
        return { state: 'provisioning', url: address, message: 'DigitalOcean: creating the Droplet…' };
      } catch (error) {
        return isMissing(error) ? { state: 'not_found' } : { state: 'provisioning', message: String(error) };
      }
    },
    async stop(instanceId) {
      await api(`/droplets/${instanceId.split(':')[0]}/actions`, { method: 'POST', body: JSON.stringify({ type: 'shutdown' }) });
    },
    async start(instanceId) {
      await api(`/droplets/${instanceId.split(':')[0]}/actions`, { method: 'POST', body: JSON.stringify({ type: 'power_on' }) });
    },
    async destroy(instanceId) {
      const [dropletId, firewallId] = instanceId.split(':');
      let hostname: string | null = null;
      try {
        hostname = (await api<{ droplet: Droplet }>(`/droplets/${dropletId}`)).droplet.name;
      } catch {
        // Already gone: the firewall and tag below still need removing.
      }
      await ignoreMissing(api(`/droplets/${dropletId}`, { method: 'DELETE' }));
      if (firewallId) await ignoreMissing(api(`/firewalls/${firewallId}`, { method: 'DELETE' }));
      if (hostname) await ignoreMissing(api(`/tags/${hostname}`, { method: 'DELETE' }));
    },
  };
}

const plugin: ServerProviderPluginModule = {
  create: (context) => createDigitalOceanProvider(settingsFrom(context)),
  status(context) {
    const settings = settingsFrom(context);
    if (!settings.apiToken || !settings.tailscaleAuthKey) {
      return {
        available: true,
        configured: false,
        message: !settings.apiToken ? 'No DigitalOcean API token.' : 'No Tailscale auth key.',
        setup_hint: 'Add a DigitalOcean API token and a Tailscale auth key in DigitalOcean Server settings. The server is only reachable on your tailnet.',
      };
    }
    return { available: true, configured: true };
  },
};

export default plugin;
