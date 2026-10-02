import type { MachineInstanceState, MachineProvider, MachineProviderPluginModule, MachineProviderPluginContext } from '@recursive/core-types/machine';

/** Fly.io over the Machines REST API. The bootstrap is the machine's init command. */

const API = 'https://api.machines.dev/v1';

interface FlySettings {
  apiToken: string;
  app: string;
  region: string;
  image: string;
  cpus: number;
  memoryMb: number;
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
  };
}

export function createFlyProvider(settings: FlySettings, http: typeof fetch = fetch): MachineProvider {
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
      const machine = await api<{ id: string }>('POST', '/machines', {
        name: `recursive-${machine_id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
        ...(settings.region ? { region: settings.region } : {}),
        config: {
          image: settings.image,
          env: bootstrap.env,
          init: { entrypoint: ['/bin/sh', '-c'], cmd: [bootstrap.command] },
          guest: { cpu_kind: 'shared', cpus: settings.cpus, memory_mb: settings.memoryMb },
          restart: { policy: 'on-failure', max_retries: 5 },
          metadata: { 'computer.recursive.machine': machine_id },
        },
      });
      return { instance_id: machine.id };
    },
    async stop(instanceId) {
      await api('POST', `/machines/${encodeURIComponent(instanceId)}/stop`, {});
    },
    async resume(instanceId) {
      // The init command runs again on start and reconnects the runner.
      await api('POST', `/machines/${encodeURIComponent(instanceId)}/start`);
    },
    async destroy(instanceId) {
      await api('DELETE', `/machines/${encodeURIComponent(instanceId)}?force=true`).catch((error) => {
        if (!/\(404\)/.test(String(error))) throw error;
      });
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
