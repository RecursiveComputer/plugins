import type {
  MachineInstanceState,
  MachineProvider,
  MachineProviderPluginContext,
  MachineProviderPluginModule,
} from '@recursivecomputer/plugin-sdk';

/**
 * E2B over its public REST API and the sandbox's envd process service
 * (Connect protocol, JSON). No SDK dependency.
 */

const ENVD_PORT = 49983;

interface E2bSettings {
  apiKey: string;
  template: string;
  timeoutSeconds: number;
  domain: string;
}

export interface E2bListing {
  instance_id: string;
  machine_id: string | null;
  registry_id: string | null;
  state: MachineInstanceState;
  created_at: number | null;
}

export type E2bProvider = MachineProvider & { list(): Promise<E2bListing[]> };

export class E2bApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const RETRIES = 3;

interface SandboxAccess {
  sandboxID: string;
  envdAccessToken?: string;
  domain?: string | null;
}

function settingsFrom(context: MachineProviderPluginContext): E2bSettings {
  const raw = context.settings;
  const minutes = typeof raw.timeoutMinutes === 'number' && raw.timeoutMinutes > 0 ? raw.timeoutMinutes : 60;
  return {
    apiKey: (typeof raw.apiKey === 'string' && raw.apiKey.trim()) || process.env.E2B_API_KEY || '',
    template: (typeof raw.template === 'string' && raw.template.trim()) || 'base',
    timeoutSeconds: Math.round(minutes * 60),
    domain: process.env.E2B_DOMAIN || 'e2b.app',
  };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Start the bootstrap detached so it outlives the RPC that launched it. */
export function detachedCommand(command: string): string {
  return `mkdir -p "$HOME/.recursive-runner" && (command -v setsid >/dev/null 2>&1 && setsid nohup sh -c ${quote(command)} || nohup sh -c ${quote(command)}) > "$HOME/.recursive-runner/runner.log" 2>&1 < /dev/null &`;
}

/** The error a Connect server-stream sends in its end-of-stream frame, if any. */
export function connectStreamError(body: Uint8Array): string | null {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let offset = 0; offset + 5 <= body.length;) {
    const flags = body[offset]!;
    const length = view.getUint32(offset + 1);
    const end = offset + 5 + length;
    if (end > body.length) return 'the runner launch reply was cut short';
    if (flags & 0x02) {
      try {
        const message = JSON.parse(new TextDecoder().decode(body.subarray(offset + 5, end))) as { error?: { code?: string; message?: string } };
        if (message.error) return message.error.message || message.error.code || 'unknown error';
      } catch {
        return 'the runner launch reply was not readable';
      }
    }
    offset = end;
  }
  return null;
}

/** One Connect-protocol envelope: flags byte, big-endian length, JSON. */
export function connectEnvelope(message: unknown): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + json.length);
  new DataView(out.buffer).setUint32(1, json.length);
  out.set(json, 5);
  return out;
}

export function createE2bProvider(
  settings: E2bSettings,
  http: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): E2bProvider {
  const once = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!settings.apiKey) throw new Error('Add an E2B API key in E2B Computers settings.');
    const response = await http(`https://api.${settings.domain}${path}`, {
      method,
      headers: { 'X-API-KEY': settings.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new E2bApiError(`E2B ${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`, response.status);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  };
  /** Retries rate limits, 5xx and dropped connections. Creating a sandbox is never retried: a lost reply may have made one. */
  const api = async <T>(method: string, path: string, body?: unknown, retry = true): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once<T>(method, path, body);
      } catch (error) {
        const transient = error instanceof E2bApiError ? TRANSIENT.has(error.status) : error instanceof Error && error.name !== 'TimeoutError' && !/API key/.test(error.message);
        if (!retry || !transient || attempt >= RETRIES) throw error;
        await wait(500 * 2 ** (attempt - 1));
      }
    }
  };

  const run = async (sandbox: SandboxAccess, command: string, envs: Record<string, string>): Promise<void> => {
    const domain = sandbox.domain || settings.domain;
    const headers: Record<string, string> = {
      'content-type': 'application/connect+json',
      'connect-protocol-version': '1',
      'E2b-Sandbox-Id': sandbox.sandboxID,
      'E2b-Sandbox-Port': String(ENVD_PORT),
      Authorization: `Basic ${Buffer.from('user:').toString('base64')}`,
    };
    if (sandbox.envdAccessToken) headers['X-Access-Token'] = sandbox.envdAccessToken;
    const response = await http(`https://sandbox.${domain}/process.Process/Start`, {
      method: 'POST',
      headers,
      body: connectEnvelope({ process: { cmd: '/bin/bash', args: ['-l', '-c', detachedCommand(command)], envs }, stdin: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`E2B could not start the runner (${response.status}): ${(await response.text()).slice(0, 300)}`);
    // The launcher backgrounds the runner and exits; reading to the end waits for that.
    const failure = connectStreamError(new Uint8Array(await response.arrayBuffer()));
    if (failure) throw new Error(`E2B could not start the runner: ${failure}`);
  };

  return {
    provider_id: 'e2b',
    async start(input) {
      const { machine_id, bootstrap } = input;
      const registry = (input as { registry_id?: string }).registry_id;
      const sandbox = await api<SandboxAccess>('POST', '/sandboxes', {
        templateID: settings.template,
        timeout: settings.timeoutSeconds,
        autoPause: true,
        secure: true,
        envVars: bootstrap.env,
        metadata: { recursive_machine_id: machine_id, ...(registry ? { recursive_registry_id: registry } : {}) },
      }, false);
      try {
        await run(sandbox, bootstrap.command, bootstrap.env);
      } catch (error) {
        // A sandbox whose runner never started would bill until its timeout; nothing else knows its id yet.
        await api('DELETE', `/sandboxes/${encodeURIComponent(sandbox.sandboxID)}`).catch(() => undefined);
        throw error;
      }
      return { instance_id: sandbox.sandboxID };
    },
    async stop(instanceId) {
      await api('POST', `/sandboxes/${encodeURIComponent(instanceId)}/pause`, { memory: true }).catch((error) => {
        if (!(error instanceof E2bApiError && error.status === 409)) throw error; // already paused
      });
    },
    async resume(instanceId) {
      // Resuming restores memory, so the runner process continues where it was.
      await api('POST', `/sandboxes/${encodeURIComponent(instanceId)}/connect`, { timeout: settings.timeoutSeconds });
    },
    async keepAlive(instanceId) {
      // Restart the sandbox's timeout from now, so a long job is not paused mid-turn while home is up.
      await api('POST', `/sandboxes/${encodeURIComponent(instanceId)}/timeout`, { timeout: settings.timeoutSeconds });
    },
    async destroy(instanceId) {
      await api('DELETE', `/sandboxes/${encodeURIComponent(instanceId)}`).catch((error) => {
        if (!(error instanceof E2bApiError && error.status === 404)) throw error;
      });
    },
    async status(instanceId): Promise<MachineInstanceState> {
      // Only a 404 means gone. Any other failure throws, so home keeps the sandbox (and its work) rather than replacing it.
      try {
        const info = await api<{ state?: string }>('GET', `/sandboxes/${encodeURIComponent(instanceId)}`);
        return info.state === 'paused' ? 'stopped' : 'running';
      } catch (error) {
        if (error instanceof E2bApiError && error.status === 404) return 'not_found';
        throw error;
      }
    },
    async list() {
      const sandboxes = await api<Array<{ sandboxID?: string; state?: string; startedAt?: string; metadata?: Record<string, string> }>>('GET', '/v2/sandboxes?state=running&state=paused&limit=100');
      return (Array.isArray(sandboxes) ? sandboxes : [])
        .filter((sandbox) => sandbox.sandboxID && sandbox.metadata?.recursive_machine_id)
        .map((sandbox) => {
          const started = sandbox.startedAt ? Date.parse(sandbox.startedAt) : NaN;
          return {
            instance_id: sandbox.sandboxID!,
            machine_id: sandbox.metadata!.recursive_machine_id ?? null,
            registry_id: sandbox.metadata!.recursive_registry_id ?? null,
            state: sandbox.state === 'paused' ? 'stopped' as const : 'running' as const,
            created_at: Number.isFinite(started) ? started : null,
          };
        });
    },
  };
}

const plugin: MachineProviderPluginModule = {
  create: (context) => createE2bProvider(settingsFrom(context)),
  status(context) {
    return settingsFrom(context).apiKey
      ? { available: true, configured: true }
      : { available: true, configured: false, message: 'No E2B API key.', setup_hint: 'Add your key from e2b.dev/dashboard in E2B Computers settings.' };
  },
};

export default plugin;
