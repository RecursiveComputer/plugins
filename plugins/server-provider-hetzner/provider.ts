import { execFile } from 'node:child_process';
import {
  type ServerOffers,
  type ServerProvider,
  type ServerProviderPluginContext,
  type ServerProviderPluginModule,
  serverTailnetHostname,
  tailnetUserData,
} from '@recursive/plugin-sdk';

const API = 'https://api.hetzner.cloud/v1';
const IMAGE = 'ubuntu-24.04';

interface HetznerSettings {
  apiToken: string;
  tailscaleAuthKey: string;
}

export interface HetznerDeps {
  fetch: typeof fetch;
  /** MagicDNS suffix of this computer's tailnet (e.g. tail1234.ts.net), when Tailscale runs here. */
  tailnetSuffix(): Promise<string | null>;
}

function settingsFrom(context: ServerProviderPluginContext): HetznerSettings {
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

export { serverTailnetHostname as tailnetHostname };

/** cloud-init user data: Tailscale first, then Recursive on the tailnet address only. */
export const hetznerUserData = tailnetUserData;

export function createHetznerProvider(settings: HetznerSettings, deps: HetznerDeps = { fetch, tailnetSuffix: localTailnetSuffix }): ServerProvider {
  async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await deps.fetch(`${API}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!response.ok) throw new Error(`Hetzner: ${body.error?.message ?? `HTTP ${response.status}`}`);
    return body;
  }

  async function url(serverId: string): Promise<string> {
    const suffix = await deps.tailnetSuffix();
    const host = serverTailnetHostname(serverId);
    return `http://${suffix ? `${host}.${suffix}` : host}:12321`;
  }

  return {
    provider_id: 'hetzner',
    async offers(): Promise<ServerOffers> {
      const [{ locations }, { server_types }] = await Promise.all([
        api<{ locations: Array<{ name: string; description: string; city: string; country: string }> }>('/locations'),
        api<{ server_types: Array<{ name: string; description: string; cores: number; memory: number; disk: number; deprecated: boolean | null; architecture: string; prices: Array<{ location: string; price_monthly: { gross: string } }> }> }>('/server_types?per_page=50'),
      ]);
      const sizes = server_types
        .filter((type) => !type.deprecated && type.architecture === 'x86' && type.memory >= 2)
        .map((type) => {
          const cheapest = Math.min(...type.prices.map((price) => Number(price.price_monthly.gross)).filter(Number.isFinite));
          return {
            id: type.name,
            label: type.name.toUpperCase(),
            detail: `${type.cores} vCPU · ${type.memory} GB · ${type.disk} GB disk`,
            monthly_price: Number.isFinite(cheapest) ? { amount: Math.round(cheapest * 100) / 100, currency: 'EUR' } : null,
          };
        })
        .sort((a, b) => (a.monthly_price?.amount ?? 1e9) - (b.monthly_price?.amount ?? 1e9));
      // The cheapest size with at least 4 GB runs Recursive and an agent comfortably.
      const recommended = sizes.find((size) => /· (4|8) GB/.test(size.detail ?? ''));
      return {
        regions: locations.map((location, index) => ({ id: location.name, label: `${location.city}, ${location.country}`, recommended: index === 0 })),
        sizes: sizes.map((size) => ({ ...size, recommended: size === recommended })),
      };
    },
    async create({ server_id, region, size, bootstrap }) {
      if (!settings.tailscaleAuthKey) throw new Error('Add a Tailscale auth key in Hetzner Server settings first.');
      const hostname = serverTailnetHostname(server_id);
      // No inbound rules: nothing on the server is reachable from the internet.
      const { firewall } = await api<{ firewall: { id: number } }>('/firewalls', {
        method: 'POST',
        body: JSON.stringify({ name: `${hostname}-closed`, rules: [], labels: { 'recursive-server': server_id } }),
      });
      try {
        const { server } = await api<{ server: { id: number } }>('/servers', {
          method: 'POST',
          body: JSON.stringify({
            name: hostname,
            server_type: size || 'cx22',
            ...(region ? { location: region } : {}),
            image: IMAGE,
            user_data: tailnetUserData(bootstrap.script, settings.tailscaleAuthKey, hostname),
            labels: { 'recursive-server': server_id },
            firewalls: [{ firewall: firewall.id }],
            start_after_create: true,
          }),
        });
        return { instance_id: `${server.id}:${firewall.id}`, url: await url(server_id) };
      } catch (error) {
        await api(`/firewalls/${firewall.id}`, { method: 'DELETE' }).catch(() => undefined);
        throw error;
      }
    },
    async status(instanceId) {
      const [serverId] = instanceId.split(':');
      try {
        const { server } = await api<{ server: { status: string; labels: Record<string, string> } }>(`/servers/${serverId}`);
        const address = await url(server.labels['recursive-server'] ?? '');
        if (server.status === 'running') return { state: 'running', url: address };
        if (server.status === 'off') return { state: 'stopped', url: address };
        return { state: 'provisioning', url: address, message: `Hetzner: ${server.status}…` };
      } catch (error) {
        return /not found/i.test(String(error)) ? { state: 'not_found' } : { state: 'provisioning', message: String(error) };
      }
    },
    async stop(instanceId) {
      await api(`/servers/${instanceId.split(':')[0]}/actions/shutdown`, { method: 'POST' });
    },
    async start(instanceId) {
      await api(`/servers/${instanceId.split(':')[0]}/actions/poweron`, { method: 'POST' });
    },
    async destroy(instanceId) {
      const [serverId, firewallId] = instanceId.split(':');
      await api(`/servers/${serverId}`, { method: 'DELETE' }).catch((error) => {
        if (!/not found/i.test(String(error))) throw error;
      });
      // The firewall frees up once the server is gone; Hetzner refuses while it is still attached.
      if (firewallId) {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await api(`/firewalls/${firewallId}`, { method: 'DELETE' });
            break;
          } catch (error) {
            if (/not found/i.test(String(error))) break;
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
        }
      }
    },
  };
}

const plugin: ServerProviderPluginModule = {
  create: (context) => createHetznerProvider(settingsFrom(context)),
  status(context) {
    const settings = settingsFrom(context);
    if (!settings.apiToken || !settings.tailscaleAuthKey) {
      return {
        available: true,
        configured: false,
        message: !settings.apiToken ? 'No Hetzner API token.' : 'No Tailscale auth key.',
        setup_hint: 'Add a Hetzner API token and a Tailscale auth key in Hetzner Server settings. The server is only reachable on your tailnet.',
      };
    }
    return { available: true, configured: true };
  },
};

export default plugin;
