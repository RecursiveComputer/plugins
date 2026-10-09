import { execFile } from 'node:child_process';
import { serverTailnetHostname, tailnetUserData } from '@recursive/core-types/server-host';
import type { ServerOffers, ServerProvider, ServerProviderPluginContext, ServerProviderPluginModule } from '@recursive/core-types/server-host';

const API = 'https://api.vultr.com/v2';
const OS_NAME = /^Ubuntu 24\.04 LTS x64$/;
/** Ubuntu 24.04 LTS x64, when the OS list cannot be read. */
const FALLBACK_OS_ID = 2284;

interface VultrSettings {
  apiToken: string;
  tailscaleAuthKey: string;
}

export interface VultrDeps {
  fetch: typeof fetch;
  /** MagicDNS suffix of this computer's tailnet (e.g. tail1234.ts.net), when Tailscale runs here. */
  tailnetSuffix(): Promise<string | null>;
}

function settingsFrom(context: ServerProviderPluginContext): VultrSettings {
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

interface VultrInstance {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'suspended' | 'resizing';
  power_status: 'running' | 'stopped' | string;
  server_status: string;
}

/** The resource is gone (deleted here or in the provider's console). */
function isMissing(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

export function createVultrProvider(settings: VultrSettings, deps: VultrDeps = { fetch, tailnetSuffix: localTailnetSuffix }): ServerProvider {
  async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
    const response = await deps.fetch(`${API}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 204) return {} as T;
    const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) throw Object.assign(new Error(`Vultr: ${body.error || `HTTP ${response.status}`}`), { status: response.status });
    return body;
  }

  async function url(hostname: string): Promise<string> {
    const suffix = await deps.tailnetSuffix();
    return `http://${suffix ? `${hostname}.${suffix}` : hostname}:12321`;
  }

  async function ubuntuOsId(): Promise<number> {
    try {
      const { os } = await api<{ os: Array<{ id: number; name: string }> }>('/os?per_page=500');
      return os.find((item) => OS_NAME.test(item.name))?.id ?? FALLBACK_OS_ID;
    } catch {
      return FALLBACK_OS_ID;
    }
  }

  return {
    provider_id: 'vultr',
    async offers(): Promise<ServerOffers> {
      const [{ regions }, { plans }] = await Promise.all([
        api<{ regions: Array<{ id: string; city: string; country: string }> }>('/regions?per_page=500'),
        api<{ plans: Array<{ id: string; vcpu_count: number; ram: number; disk: number; monthly_cost: number; locations: string[] }> }>('/plans?type=vc2&per_page=500'),
      ]);
      const sizes = plans
        .filter((plan) => plan.ram >= 2048 && plan.locations.length > 0)
        .map((plan) => ({
          id: plan.id,
          label: plan.id,
          detail: `${plan.vcpu_count} vCPU · ${plan.ram / 1024} GB · ${plan.disk} GB disk`,
          monthly_price: { amount: plan.monthly_cost, currency: 'USD' },
        }))
        .sort((a, b) => a.monthly_price.amount - b.monthly_price.amount);
      // The cheapest size with at least 4 GB runs Recursive and an agent comfortably.
      const recommended = sizes.find((size) => /· (4|8) GB/.test(size.detail));
      return {
        regions: regions.map((region, index) => ({ id: region.id, label: `${region.city}, ${region.country}`, recommended: index === 0 })),
        sizes: sizes.map((size) => ({ ...size, recommended: size === recommended })),
      };
    },
    async create({ server_id, region, size, bootstrap }) {
      if (!settings.tailscaleAuthKey) throw new Error('Add a Tailscale auth key in Vultr Server settings first.');
      const hostname = serverTailnetHostname(server_id);
      // A firewall group with no rules drops all inbound traffic; Tailscale works over outbound connections.
      const { firewall_group } = await api<{ firewall_group: { id: string } }>('/firewalls', {
        method: 'POST',
        body: JSON.stringify({ description: `${hostname}-closed` }),
      });
      try {
        const { instance } = await api<{ instance: VultrInstance }>('/instances', {
          method: 'POST',
          body: JSON.stringify({
            region: region || 'ewr',
            plan: size || 'vc2-2c-4gb',
            os_id: await ubuntuOsId(),
            label: hostname,
            hostname,
            user_data: Buffer.from(tailnetUserData(bootstrap.script, settings.tailscaleAuthKey, hostname)).toString('base64'),
            firewall_group_id: firewall_group.id,
            backups: 'disabled',
          }),
        });
        return { instance_id: `${instance.id}:${firewall_group.id}`, url: await url(hostname) };
      } catch (error) {
        await api(`/firewalls/${firewall_group.id}`, { method: 'DELETE' }).catch(() => undefined);
        throw error;
      }
    },
    async status(instanceId) {
      const [id] = instanceId.split(':');
      try {
        const { instance } = await api<{ instance: VultrInstance }>(`/instances/${id}`);
        const address = await url(instance.label);
        if (instance.status === 'active' && instance.power_status === 'stopped') return { state: 'stopped', url: address };
        if (instance.status === 'active' && instance.server_status === 'ok') return { state: 'running', url: address };
        if (instance.status === 'suspended') return { state: 'error', url: address, message: 'Vultr suspended this server. Check your Vultr account.' };
        return { state: 'provisioning', url: address, message: `Vultr: ${instance.server_status === 'none' ? instance.status : instance.server_status}…` };
      } catch (error) {
        return isMissing(error) ? { state: 'not_found' } : { state: 'provisioning', message: String(error) };
      }
    },
    async stop(instanceId) {
      await api(`/instances/${instanceId.split(':')[0]}/halt`, { method: 'POST' });
    },
    async start(instanceId) {
      await api(`/instances/${instanceId.split(':')[0]}/start`, { method: 'POST' });
    },
    async destroy(instanceId) {
      const [id, firewallId] = instanceId.split(':');
      await api(`/instances/${id}`, { method: 'DELETE' }).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      // The group frees up once the instance is gone; Vultr refuses while it is still attached.
      if (firewallId) {
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            await api(`/firewalls/${firewallId}`, { method: 'DELETE' });
            break;
          } catch (error) {
            if (isMissing(error)) break;
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
        }
      }
    },
  };
}

const plugin: ServerProviderPluginModule = {
  create: (context) => createVultrProvider(settingsFrom(context)),
  status(context) {
    const settings = settingsFrom(context);
    if (!settings.apiToken || !settings.tailscaleAuthKey) {
      return {
        available: true,
        configured: false,
        message: !settings.apiToken ? 'No Vultr API key.' : 'No Tailscale auth key.',
        setup_hint: 'Add a Vultr API key and a Tailscale auth key in Vultr Server settings. The server is only reachable on your tailnet.',
      };
    }
    return { available: true, configured: true };
  },
};

export default plugin;
