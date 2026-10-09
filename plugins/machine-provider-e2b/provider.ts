import type {
  MachineInstanceState,
  MachineProvider,
  MachineProviderPluginContext,
  MachineProviderPluginModule,
} from '@recursive/plugin-sdk';

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

/** One Connect-protocol envelope: flags byte, big-endian length, JSON. */
export function connectEnvelope(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + json.length);
  new DataView(out.buffer).setUint32(1, json.length);
  out.set(json, 5);
  return out;
}

export function createE2bProvider(settings: E2bSettings, http: typeof fetch = fetch): MachineProvider {
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!settings.apiKey) throw new Error('Add an E2B API key in E2B Machines settings.');
    const response = await http(`https://api.${settings.domain}${path}`, {
      method,
      headers: { 'X-API-KEY': settings.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`E2B ${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
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
    await response.arrayBuffer();
  };

  return {
    provider_id: 'e2b',
    async start({ machine_id, bootstrap }) {
      const sandbox = await api<SandboxAccess>('POST', '/sandboxes', {
        templateID: settings.template,
        timeout: settings.timeoutSeconds,
        autoPause: true,
        secure: true,
        envVars: bootstrap.env,
        metadata: { recursive_machine_id: machine_id },
      });
      await run(sandbox, bootstrap.command, bootstrap.env);
      return { instance_id: sandbox.sandboxID };
    },
    async stop(instanceId) {
      await api('POST', `/sandboxes/${encodeURIComponent(instanceId)}/pause`, { memory: true }).catch((error) => {
        if (!/\(409\)/.test(String(error))) throw error; // already paused
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
        if (!/\(404\)/.test(String(error))) throw error;
      });
    },
    async status(instanceId): Promise<MachineInstanceState> {
      try {
        const info = await api<{ state?: string }>('GET', `/sandboxes/${encodeURIComponent(instanceId)}`);
        return info.state === 'paused' ? 'stopped' : 'running';
      } catch {
        return 'not_found';
      }
    },
  };
}

const plugin: MachineProviderPluginModule = {
  create: (context) => createE2bProvider(settingsFrom(context)),
  status(context) {
    return settingsFrom(context).apiKey
      ? { available: true, configured: true }
      : { available: true, configured: false, message: 'No E2B API key.', setup_hint: 'Add your key from e2b.dev/dashboard in E2B Machines settings.' };
  },
};

export default plugin;
