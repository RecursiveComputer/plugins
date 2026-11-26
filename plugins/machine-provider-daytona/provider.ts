import type {
  MachineInstanceState,
  MachineProvider,
  MachineProviderPluginContext,
  MachineProviderPluginModule,
} from '@recursivecomputer/plugin-sdk';

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
  labels?: Record<string, string>;
  createdAt?: string;
}

export interface DaytonaListing {
  instance_id: string;
  machine_id: string | null;
  registry_id: string | null;
  state: MachineInstanceState;
  created_at: number | null;
}

export type DaytonaProvider = MachineProvider & { list(): Promise<DaytonaListing[]> };

export class DaytonaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const MACHINE_LABEL = 'computer.recursive.machine';
const REGISTRY_LABEL = 'computer.recursive.registry';
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const RETRIES = 3;
const GONE_STATES = new Set(['destroyed', 'destroying']);

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
): DaytonaProvider {
  const once = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
    if (!settings.apiKey) throw new Error('Add a Daytona API key in Daytona Computers settings.');
    const response = await http(url, {
      method,
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new DaytonaApiError(`Daytona ${method} ${new URL(url).pathname} failed (${response.status}): ${(await response.text()).slice(0, 300)}`, response.status);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
  /** Retries rate limits, 5xx and dropped connections. Creating a sandbox is never retried: a lost reply may have made one. */
  const request = async <T>(method: string, url: string, body?: unknown, retry = true): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once<T>(method, url, body);
      } catch (error) {
        const transient = error instanceof DaytonaApiError ? TRANSIENT.has(error.status) : error instanceof Error && error.name !== 'TimeoutError' && !/API key/.test(error.message);
        if (!retry || !transient || attempt >= RETRIES) throw error;
        await wait(500 * 2 ** (attempt - 1));
      }
    }
  };
  const api = <T>(method: string, path: string, body?: unknown, retry = true) => request<T>(method, `${settings.apiUrl}${path}`, body, retry);
  const get = (id: string) => api<Sandbox>('GET', `/sandbox/${encodeURIComponent(id)}`);
  const remove = (id: string) => api('DELETE', `/sandbox/${encodeURIComponent(id)}`).catch((error) => {
    if (!(error instanceof DaytonaApiError && error.status === 404)) throw error;
  });

  const waitForState = async (id: string, wanted: string): Promise<Sandbox> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const sandbox = await get(id);
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
    async start(input) {
      const { machine_id, bootstrap } = input;
      const registry = (input as { registry_id?: string }).registry_id;
      const created = await api<Sandbox>('POST', '/sandbox', {
        ...(settings.snapshot ? { snapshot: settings.snapshot } : {}),
        cpu: settings.cpu,
        memory: settings.memory,
        disk: settings.disk,
        env: bootstrap.env,
        labels: { [MACHINE_LABEL]: machine_id, ...(registry ? { [REGISTRY_LABEL]: registry } : {}) },
        // Home pauses idle machines and keeps busy ones alive; this timer only fires when home is asleep or
        // closed. Stopping keeps the disk, so a job it cuts off hands its work in on the next start.
        autoStopInterval: settings.autoStopMinutes,
      }, false);
      try {
        const sandbox = await waitForState(created.id, 'started');
        await launch(sandbox, bootstrap.command, bootstrap.env);
      } catch (error) {
        // A sandbox whose runner never started would bill until its idle timer; nothing else knows its id yet.
        await remove(created.id).catch(() => undefined);
        throw error;
      }
      return { instance_id: created.id };
    },
    async stop(instanceId) {
      const current = await get(instanceId);
      if (current.state === 'stopped' || current.state === 'stopping' || current.state === 'archived') return;
      await api('POST', `/sandbox/${encodeURIComponent(instanceId)}/stop`).catch((error) => {
        if (!(error instanceof DaytonaApiError && error.status === 409)) throw error;
      });
    },
    async resume(instanceId, input) {
      const current = await get(instanceId);
      if (current.state !== 'started' && current.state !== 'starting') {
        await api('POST', `/sandbox/${encodeURIComponent(instanceId)}/start`).catch((error) => {
          if (!(error instanceof DaytonaApiError && error.status === 409)) throw error;
        });
      }
      const sandbox = await waitForState(instanceId, 'started');
      // A stopped sandbox keeps its disk but not processes: start the runner again from its saved script.
      // A fresh enrollment rides along in case the runner lost its identity.
      const enroll = input?.bootstrap.env.RECURSIVE_MACHINE_ENROLL;
      await launch(sandbox, 'sh "$HOME/.recursive-runner/start.sh"', enroll ? { RECURSIVE_MACHINE_ENROLL: enroll } : {});
    },
    async keepAlive(instanceId) {
      // Any toolbox call counts as activity for Daytona's idle timer.
      const sandbox = await get(instanceId);
      const toolbox = (sandbox.toolboxProxyUrl || `${settings.apiUrl}/toolbox`).replace(/\/$/, '');
      await request('POST', `${toolbox}/${encodeURIComponent(instanceId)}/process/execute`, { command: 'true', timeout: 10 });
    },
    async destroy(instanceId) {
      await remove(instanceId);
    },
    async status(instanceId): Promise<MachineInstanceState> {
      // Only a 404 means gone. Any other failure throws, so home keeps the sandbox (and its work) rather than replacing it.
      try {
        const sandbox = await get(instanceId);
        return sandbox.state === 'started' ? 'running' : GONE_STATES.has(sandbox.state ?? '') ? 'not_found' : 'stopped';
      } catch (error) {
        if (error instanceof DaytonaApiError && error.status === 404) return 'not_found';
        throw error;
      }
    },
    async list() {
      const sandboxes = await api<Sandbox[] | { items?: Sandbox[] }>('GET', '/sandbox');
      const items = Array.isArray(sandboxes) ? sandboxes : sandboxes.items ?? [];
      return items
        .filter((sandbox) => sandbox.id && sandbox.labels?.[MACHINE_LABEL] && !GONE_STATES.has(sandbox.state ?? ''))
        .map((sandbox) => {
          const created = sandbox.createdAt ? Date.parse(sandbox.createdAt) : NaN;
          return {
            instance_id: sandbox.id,
            machine_id: sandbox.labels![MACHINE_LABEL] ?? null,
            registry_id: sandbox.labels![REGISTRY_LABEL] ?? null,
            state: sandbox.state === 'started' ? 'running' as const : 'stopped' as const,
            created_at: Number.isFinite(created) ? created : null,
          };
        });
    },
  };
}

const plugin: MachineProviderPluginModule = {
  create: (context) => createDaytonaProvider(settingsFrom(context)),
  status(context) {
    return settingsFrom(context).apiKey
      ? { available: true, configured: true }
      : { available: true, configured: false, message: 'No Daytona API key.', setup_hint: 'Add your key from app.daytona.io in Daytona Computers settings.' };
  },
};

export default plugin;
