import { execFile } from 'node:child_process';
import {
  type ServerOffers,
  type ServerProvider,
  type ServerProviderPluginContext,
  type ServerProviderPluginModule,
  serverTailnetHostname,
  tailnetUserData,
} from '@recursivecomputer/plugin-sdk';

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
  /** Pause between polls of a running action (tests skip it). */
  sleep?(ms: number): Promise<void>;
}

interface HetznerAction {
  id: number;
  command: string;
  status: 'running' | 'success' | 'error';
  error?: { code?: string; message?: string } | null;
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

/** Resizing and volumes are newer than some published SDKs' ServerProvider: this provider always has them. */
export type HetznerServerProvider = ServerProvider & { resize(instanceId: string, size: string): Promise<void>; volumes: ServerVolumes };

export interface ServerVolume {
  volume_id: string;
  name: string;
  size_gb: number;
  location: string | null;
  attached_to: string | null;
  device: string | null;
  state: 'creating' | 'available' | 'error';
}

export interface ServerVolumes {
  readonly limits: { min_gb: number; max_gb: number };
  create(input: { instance_id: string; name: string; size_gb: number; labels?: Record<string, string> }): Promise<ServerVolume>;
  get(volume_id: string): Promise<ServerVolume | null>;
  grow(volume_id: string, size_gb: number): Promise<ServerVolume>;
  attach(volume_id: string, instance_id: string): Promise<ServerVolume>;
  detach(volume_id: string): Promise<ServerVolume>;
  remove(volume_id: string): Promise<void>;
}

export const HETZNER_VOLUME_LIMITS = { min_gb: 10, max_gb: 10_240 } as const;

interface HetznerVolume {
  id: number;
  name: string;
  size: number;
  server: number | null;
  linux_device: string | null;
  status: string;
  location?: { name?: string } | null;
}

function volumeFrom(volume: HetznerVolume): ServerVolume {
  return {
    volume_id: String(volume.id),
    name: volume.name,
    size_gb: volume.size,
    location: volume.location?.name ?? null,
    attached_to: volume.server === null ? null : String(volume.server),
    device: volume.linux_device ?? null,
    state: volume.status === 'available' ? 'available' : volume.status === 'creating' ? 'creating' : 'error',
  };
}

export function hetznerVolumeName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
  if (!cleaned) throw new Error('A volume needs a name.');
  return cleaned;
}

function checkSize(sizeGb: number): void {
  if (!Number.isInteger(sizeGb) || sizeGb < HETZNER_VOLUME_LIMITS.min_gb || sizeGb > HETZNER_VOLUME_LIMITS.max_gb) {
    throw new Error(`A Hetzner volume is ${HETZNER_VOLUME_LIMITS.min_gb} to ${HETZNER_VOLUME_LIMITS.max_gb} GB, in whole GB.`);
  }
}

export function createHetznerProvider(settings: HetznerSettings, deps: HetznerDeps = { fetch, tailnetSuffix: localTailnetSuffix }): HetznerServerProvider {
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

  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function until(done: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await done()) return true;
      if (Date.now() > deadline) return false;
      await wait(3_000);
    }
  }

  /** Wait for a Hetzner action to finish; its error is the thrown message. */
  async function finished({ action }: { action: HetznerAction }, timeoutMs = 120_000): Promise<void> {
    let state = action;
    const done = await until(async () => {
      if (state.status === 'running') state = (await api<{ action: HetznerAction }>(`/actions/${action.id}`)).action;
      return state.status !== 'running';
    }, timeoutMs);
    if (!done) throw new Error(`Hetzner: ${action.command} is still running after ${Math.round(timeoutMs / 60_000)} minutes.`);
    if (state.status === 'error') throw new Error(`Hetzner: ${state.error?.message ?? `${action.command} failed`}`);
  }

  async function url(serverId: string): Promise<string> {
    const suffix = await deps.tailnetSuffix();
    const host = serverTailnetHostname(serverId);
    return `http://${suffix ? `${host}.${suffix}` : host}:12321`;
  }

  async function volume(volumeId: string): Promise<ServerVolume> {
    return volumeFrom((await api<{ volume: HetznerVolume }>(`/volumes/${volumeId}`)).volume);
  }

  async function volumeAction(volumeId: string, action: string, body: Record<string, unknown> = {}): Promise<ServerVolume> {
    await finished(await api<{ action: HetznerAction }>(`/volumes/${volumeId}/actions/${action}`, { method: 'POST', body: JSON.stringify(body) }));
    return volume(volumeId);
  }

  const volumes: ServerVolumes = {
    limits: HETZNER_VOLUME_LIMITS,
    async create({ instance_id, name, size_gb, labels }) {
      checkSize(size_gb);
      const created = await api<{ volume: HetznerVolume; action: HetznerAction; next_actions?: HetznerAction[] }>('/volumes', {
        method: 'POST',
        body: JSON.stringify({
          name: hetznerVolumeName(name),
          size: size_gb,
          server: Number(instance_id.split(':')[0]),
          automount: false,
          format: 'ext4',
          ...(labels ? { labels } : {}),
        }),
      });
      await finished({ action: created.action });
      for (const next of created.next_actions ?? []) await finished({ action: next });
      return volume(String(created.volume.id));
    },
    async get(volumeId) {
      try {
        return await volume(volumeId);
      } catch (error) {
        if (/not found/i.test(String(error))) return null;
        throw error;
      }
    },
    async grow(volumeId, sizeGb) {
      checkSize(sizeGb);
      const current = await volume(volumeId);
      if (sizeGb < current.size_gb) throw new Error(`A volume cannot shrink: it is ${current.size_gb} GB.`);
      if (sizeGb === current.size_gb) return current;
      return volumeAction(volumeId, 'resize', { size: sizeGb });
    },
    async attach(volumeId, instanceId) {
      const serverId = Number(instanceId.split(':')[0]);
      const current = await volume(volumeId);
      if (current.attached_to === String(serverId)) return current;
      if (current.attached_to) throw new Error(`The volume is attached to another server (${current.attached_to}); detach it first.`);
      return volumeAction(volumeId, 'attach', { server: serverId, automount: false });
    },
    async detach(volumeId) {
      const current = await volume(volumeId);
      if (!current.attached_to) return current;
      return volumeAction(volumeId, 'detach');
    },
    async remove(volumeId) {
      const current = await volumes.get(volumeId);
      if (!current) return;
      if (current.attached_to) throw new Error('Detach the volume before deleting it.');
      await api(`/volumes/${volumeId}`, { method: 'DELETE' });
    },
  };

  return {
    provider_id: 'hetzner',
    volumes,
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
    async resize(instanceId, size) {
      const serverId = instanceId.split(':')[0];
      // Hetzner changes the type of a server that is off only.
      const current = async () => (await api<{ server: { status: string } }>(`/servers/${serverId}`)).server.status;
      if ((await current()) !== 'off') {
        await api(`/servers/${serverId}/actions/shutdown`, { method: 'POST' });
        if (!(await until(async () => (await current()) === 'off', 120_000))) {
          // The OS did not shut down in time: cut the power, the disk is kept.
          await finished(await api<{ action: HetznerAction }>(`/servers/${serverId}/actions/poweroff`, { method: 'POST' }));
        }
      }
      try {
        // upgrade_disk: the point is more room; the server cannot go back to a smaller type after.
        await finished(
          await api<{ action: HetznerAction }>(`/servers/${serverId}/actions/change_type`, {
            method: 'POST',
            body: JSON.stringify({ server_type: size, upgrade_disk: true }),
          }),
          600_000,
        );
      } finally {
        await api(`/servers/${serverId}/actions/poweron`, { method: 'POST' });
      }
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
