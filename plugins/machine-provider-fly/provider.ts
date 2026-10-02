import type { MachineInstanceState, MachineProvider, MachineProviderPluginModule, MachineProviderPluginContext } from '@recursive/core-types/machine';

/**
 * Fly.io over the Machines REST API. The bootstrap is the machine's init command.
 *
 * A Fly Machine's root filesystem resets when it restarts, so by default each
 * machine gets a volume at /data for the runner's state and session checkouts:
 * work a stop cuts off is still there to hand in on the next start.
 */

const API = 'https://api.machines.dev/v1';
/** Volumes need a region; this one is used when the setting is empty. */
const DEFAULT_VOLUME_REGION = 'iad';
const DATA_PATH = '/data';

interface FlySettings {
  apiToken: string;
  app: string;
  region: string;
  image: string;
  cpus: number;
  memoryMb: number;
  /** Keep the runner's state and checkouts on a volume that survives restarts. */
  persistDisk: boolean;
  volumeSizeGb: number;
}

function settingsFrom(context: MachineProviderPluginContext): FlySettings {
  const raw = context.settings;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
  const number = (key: string, fallback: number) => (typeof raw[key] === 'number' && (raw[key] as number) > 0 ? (raw[key] as number) : fallback);
  return {
    apiToken: text('apiToken') || process.env.FLY_API_TOKEN || '',
    app: text('app'),
    region: text('region'),
    image: text('image') || 'node:22-bookworm',
    cpus: number('cpus', 2),
    memoryMb: number('memoryMb', 4096),
    persistDisk: raw.persistDisk !== false,
    volumeSizeGb: number('volumeSizeGb', 10),
  };
}

/** Fly volume names: lowercase letters, digits, and underscores, at most 30 characters. */
export function volumeName(machineId: string): string {
  return `recursive_${machineId.toLowerCase().replace(/[^a-z0-9]/g, '_')}`.slice(0, 30);
}

interface FlyMachine {
  id: string;
  state?: string;
  config?: { env?: Record<string, string>; mounts?: Array<{ volume: string; path: string }> } & Record<string, unknown>;
}

export function createFlyProvider(
  settings: FlySettings,
  http: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): MachineProvider {
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!settings.apiToken || !settings.app) throw new Error('Set the Fly API token and app in Fly.io Machines settings.');
    const response = await http(`${API}/apps/${encodeURIComponent(settings.app)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Fly ${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };

  return {
    provider_id: 'fly',
    async start({ machine_id, bootstrap }) {
      const region = settings.region || (settings.persistDisk ? DEFAULT_VOLUME_REGION : '');
      const volume = settings.persistDisk
        ? await api<{ id: string }>('POST', '/volumes', { name: volumeName(machine_id), region, size_gb: settings.volumeSizeGb })
        : null;
      try {
        const machine = await api<{ id: string }>('POST', '/machines', {
          name: `recursive-${machine_id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
          ...(region ? { region } : {}),
          config: {
            image: settings.image,
            env: {
              ...bootstrap.env,
              ...(volume ? { RECURSIVE_RUNNER_DIR: `${DATA_PATH}/runner`, RECURSIVE_RUNNER_WORKSPACES: `${DATA_PATH}/sessions` } : {}),
            },
            init: { entrypoint: ['/bin/sh', '-c'], cmd: [bootstrap.command] },
            guest: { cpu_kind: 'shared', cpus: settings.cpus, memory_mb: settings.memoryMb },
            restart: { policy: 'on-failure', max_retries: 5 },
            metadata: { 'computer.recursive.machine': machine_id },
            ...(volume ? { mounts: [{ volume: volume.id, path: DATA_PATH }] } : {}),
          },
        });
        return { instance_id: machine.id };
      } catch (error) {
        if (volume) await api('DELETE', `/volumes/${encodeURIComponent(volume.id)}`).catch(() => undefined);
        throw error;
      }
    },
    async stop(instanceId) {
      await api('POST', `/machines/${encodeURIComponent(instanceId)}/stop`, {});
    },
    async resume(instanceId, input) {
      // The init command runs again on start. With a volume the runner keeps its identity; without one it
      // needs the fresh enrollment home sent, written into the machine's env first.
      const enroll = input?.bootstrap.env.RECURSIVE_MACHINE_ENROLL;
      if (enroll && !settings.persistDisk) {
        const machine = await api<FlyMachine>('GET', `/machines/${encodeURIComponent(instanceId)}`);
        const config = { ...machine.config, env: { ...machine.config?.env, RECURSIVE_MACHINE_ENROLL: enroll } };
        await api('POST', `/machines/${encodeURIComponent(instanceId)}`, { config, skip_launch: true });
      }
      await api('POST', `/machines/${encodeURIComponent(instanceId)}/start`);
    },
    async destroy(instanceId) {
      const machine = await api<FlyMachine>('GET', `/machines/${encodeURIComponent(instanceId)}`).catch(() => null);
      await api('DELETE', `/machines/${encodeURIComponent(instanceId)}?force=true`).catch((error) => {
        if (!/\(404\)/.test(String(error))) throw error;
      });
      // The volume detaches once the machine is gone; retry briefly while it does.
      for (const mount of machine?.config?.mounts ?? []) {
        for (let attempt = 0; ; attempt++) {
          try {
            await api('DELETE', `/volumes/${encodeURIComponent(mount.volume)}`);
            break;
          } catch (error) {
            if (/\(404\)/.test(String(error))) break;
            if (attempt >= 5) throw error;
            await wait(2_000);
          }
        }
      }
    },
    async status(instanceId): Promise<MachineInstanceState> {
      try {
        const machine = await api<{ state?: string }>('GET', `/machines/${encodeURIComponent(instanceId)}`);
        if (machine.state === 'started' || machine.state === 'starting') return 'running';
        if (machine.state === 'destroyed') return 'not_found';
        return 'stopped';
      } catch {
        return 'not_found';
      }
    },
  };
}

const plugin: MachineProviderPluginModule = {
  create: (context) => createFlyProvider(settingsFrom(context)),
  status(context) {
    const settings = settingsFrom(context);
    if (settings.apiToken && settings.app) return { available: true, configured: true };
    return { available: true, configured: false, message: 'Fly token or app not set.', setup_hint: 'Create an app with `fly apps create`, then add a token and the app name in Fly.io Machines settings.' };
  },
};

export default plugin;
