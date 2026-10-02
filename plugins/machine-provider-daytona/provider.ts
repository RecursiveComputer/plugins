import type { MachineInstanceState, MachineProvider, MachineProviderPluginModule, MachineProviderPluginContext } from '@recursive/core-types/machine';

/** Daytona over its REST API (control plane) and the sandbox toolbox API (process execute). */

interface DaytonaSettings {
  apiKey: string;
  apiUrl: string;
  snapshot: string;
  cpu: number;
  memory: number;
  disk: number;
  /** Daytona's own idle timer, a backstop for when home cannot stop the sandbox. 0 turns it off. */
  autoStopMinutes: number;
}

interface Sandbox {
  id: string;
  state?: string;
  toolboxProxyUrl?: string;
}

function settingsFrom(context: MachineProviderPluginContext): DaytonaSettings {
  const raw = context.settings;
  const number = (key: string, fallback: number) => (typeof raw[key] === 'number' && (raw[key] as number) > 0 ? (raw[key] as number) : fallback);
  return {
    apiKey: (typeof raw.apiKey === 'string' && raw.apiKey.trim()) || process.env.DAYTONA_API_KEY || '',
    apiUrl: ((typeof raw.apiUrl === 'string' && raw.apiUrl.trim()) || process.env.DAYTONA_API_URL || 'https://app.daytona.io/api').replace(/\/$/, ''),
    snapshot: typeof raw.snapshot === 'string' ? raw.snapshot.trim() : '',
    cpu: number('cpu', 2),
    memory: number('memory', 4),
    disk: number('disk', 10),
    autoStopMinutes: typeof raw.autoStopMinutes === 'number' && raw.autoStopMinutes >= 0 ? Math.round(raw.autoStopMinutes) : 60,
  };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function detachedCommand(command: string): string {
  return `sh -c ${quote(`mkdir -p "$HOME/.recursive-runner" && (command -v setsid >/dev/null 2>&1 && setsid nohup sh -c ${quote(command)} || nohup sh -c ${quote(command)}) > "$HOME/.recursive-runner/runner.log" 2>&1 < /dev/null &`)}`;
}

export function createDaytonaProvider(
  settings: DaytonaSettings,
  http: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): MachineProvider {
  const request = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    if (!settings.apiKey) throw new Error('Add a Daytona API key in Daytona Machines settings.');
    const response = await http(url, {
      method,
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Daytona ${method} ${new URL(url).pathname} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
  const api = <T>(method: string, path: string, body?: unknown) => request<T>(method, `${settings.apiUrl}${path}`, body);

  const waitForState = async (id: string, wanted: string): Promise<Sandbox> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const sandbox = await api<Sandbox>('GET', `/sandbox/${encodeURIComponent(id)}`);
      if (sandbox.state === wanted) return sandbox;
      if (sandbox.state === 'error' || sandbox.state === 'build_failed') throw new Error(`Daytona sandbox ${id} is in state ${sandbox.state}`);
      await wait(2_000);
    }
    throw new Error(`Daytona sandbox ${id} did not reach ${wanted}`);
  };

  const launch = async (sandbox: Sandbox, command: string, envs: Record<string, string>) => {
    const toolbox = (sandbox.toolboxProxyUrl || `${settings.apiUrl}/toolbox`).replace(/\/$/, '');
    await request('POST', `${toolbox}/${encodeURIComponent(sandbox.id)}/process/execute`, { command: detachedCommand(command), envs, timeout: 60 });
  };

  return {
    provider_id: 'daytona',
    async start({ machine_id, bootstrap }) {
      const created = await api<Sandbox>('POST', '/sandbox', {
        ...(settings.snapshot ? { snapshot: settings.snapshot } : {}),
        cpu: settings.cpu,
        memory: settings.memory,
        disk: settings.disk,
        env: bootstrap.env,
        labels: { 'computer.recursive.machine': machine_id },
        // Home pauses idle machines and keeps busy ones alive; this timer only fires when home is asleep or
        // closed. Stopping keeps the disk, so a job it cuts off hands its work in on the next start.
        autoStopInterval: settings.autoStopMinutes,
      });
      const sandbox = await waitForState(created.id, 'started');
      await launch(sandbox, bootstrap.command, bootstrap.env);
      return { instance_id: created.id };
    },
    async stop(instanceId) {
      await api('POST', `/sandbox/${encodeURIComponent(instanceId)}/stop`);
    },
    async resume(instanceId, input) {
      await api('POST', `/sandbox/${encodeURIComponent(instanceId)}/start`);
      const sandbox = await waitForState(instanceId, 'started');
      // A stopped sandbox keeps its disk but not processes: start the runner again from its saved script.
      // A fresh enrollment rides along in case the runner lost its identity.
      const enroll = input?.bootstrap.env.RECURSIVE_MACHINE_ENROLL;
      await launch(sandbox, 'sh "$HOME/.recursive-runner/start.sh"', enroll ? { RECURSIVE_MACHINE_ENROLL: enroll } : {});
    },
    async keepAlive(instanceId) {
      // Any toolbox call counts as activity for Daytona's idle timer.
      const sandbox = await api<Sandbox>('GET', `/sandbox/${encodeURIComponent(instanceId)}`);
      const toolbox = (sandbox.toolboxProxyUrl || `${settings.apiUrl}/toolbox`).replace(/\/$/, '');
      await request('POST', `${toolbox}/${encodeURIComponent(instanceId)}/process/execute`, { command: 'true', timeout: 10 });
    },
    async destroy(instanceId) {
      await api('DELETE', `/sandbox/${encodeURIComponent(instanceId)}`).catch((error) => {
        if (!/\(404\)/.test(String(error))) throw error;
      });
    },
    async status(instanceId): Promise<MachineInstanceState> {
      try {
        const sandbox = await api<Sandbox>('GET', `/sandbox/${encodeURIComponent(instanceId)}`);
        return sandbox.state === 'started' ? 'running' : sandbox.state === 'destroyed' ? 'not_found' : 'stopped';
      } catch {
        return 'not_found';
      }
    },
  };
}

const plugin: MachineProviderPluginModule = {
  create: (context) => createDaytonaProvider(settingsFrom(context)),
  status(context) {
    return settingsFrom(context).apiKey
      ? { available: true, configured: true }
      : { available: true, configured: false, message: 'No Daytona API key.', setup_hint: 'Add your key from app.daytona.io in Daytona Machines settings.' };
  },
};

export default plugin;
