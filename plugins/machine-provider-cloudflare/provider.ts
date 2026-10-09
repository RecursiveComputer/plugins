import type {
  MachineInstanceState,
  MachineProvider,
  MachineProviderPluginContext,
  MachineProviderPluginModule,
  MachineProviderStatus,
} from '@recursivecomputer/plugin-sdk';

/**
 * Cloudflare Sandboxes (Containers on Durable Objects). Cloudflare has no REST
 * API for them, so the user deploys the small Worker in `./worker` to their
 * account once; this provider calls it. Each machine is one Durable Object.
 */

interface CloudflareSettings {
  workerUrl: string;
  apiToken: string;
  instanceType: string;
  idleMinutes: number;
}

function settingsFrom(context: MachineProviderPluginContext): CloudflareSettings {
  const raw = context.settings;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '');
  const idle = typeof raw.idleMinutes === 'number' && raw.idleMinutes > 0 ? raw.idleMinutes : 60;
  return {
    workerUrl: (text('workerUrl') || process.env.RECURSIVE_CLOUDFLARE_MACHINES_URL || '').replace(
      /\/$/,
      '',
    ),
    apiToken: text('apiToken') || process.env.RECURSIVE_CLOUDFLARE_MACHINES_TOKEN || '',
    instanceType: text('instanceType') || 'standard-2',
    // Cloudflare caps a container's inactivity timeout at six hours.
    idleMinutes: Math.min(360, Math.round(idle)),
  };
}

export function createCloudflareProvider(
  settings: CloudflareSettings,
  http: typeof fetch = fetch,
): MachineProvider {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (!settings.workerUrl || !settings.apiToken)
      throw new Error(
        'Deploy the Recursive machines Worker and add its URL and token in Cloudflare Machines settings.',
      );
    const response = await http(`${settings.workerUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${settings.apiToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `Cloudflare machines Worker ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text) : {}) as T;
  };
  const machine = (id: string, action = '') =>
    `/machines/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;

  return {
    provider_id: 'cloudflare',
    async start({ machine_id, bootstrap }) {
      await call('POST', machine(machine_id, 'start'), {
        command: bootstrap.command,
        env: bootstrap.env,
        instance: settings.instanceType,
        idle_minutes: settings.idleMinutes,
      });
      // The Durable Object is addressed by name, so the machine id is the instance id.
      return { instance_id: machine_id };
    },
    async stop(instanceId) {
      await call('POST', machine(instanceId, 'stop'));
    },
    async resume(instanceId, input) {
      await call(
        'POST',
        machine(instanceId, 'resume'),
        input ? { command: input.bootstrap.command, env: input.bootstrap.env } : {},
      );
    },
    async keepAlive(instanceId) {
      await call('POST', machine(instanceId, 'keepalive'));
    },
    async destroy(instanceId) {
      await call('DELETE', machine(instanceId));
    },
    async status(instanceId): Promise<MachineInstanceState> {
      try {
        const { state } = await call<{ state?: string }>('GET', machine(instanceId));
        return state === 'running' ? 'running' : state === 'stopped' ? 'stopped' : 'not_found';
      } catch {
        return 'not_found';
      }
    },
  };
}

const SETUP_HINT =
  'Deploy the Worker once: in plugins/shared/machine-provider-cloudflare/worker run `npm install`, `npx wrangler deploy`, and `npx wrangler secret put RECURSIVE_TOKEN`, then add the Worker URL and that token in Cloudflare Machines settings.';

/** The settings page polls provider status; check the Worker at most once a minute. */
const HEALTH_TTL_MS = 60_000;
let health: { key: string; at: number; status: MachineProviderStatus } | null = null;

const plugin: MachineProviderPluginModule = {
  create: (context) => createCloudflareProvider(settingsFrom(context)),
  async status(context) {
    const settings = settingsFrom(context);
    if (!settings.workerUrl || !settings.apiToken) {
      return {
        available: true,
        configured: false,
        message: 'The machines Worker is not set up.',
        setup_hint: SETUP_HINT,
      };
    }
    const key = `${settings.workerUrl}\n${settings.apiToken}`;
    if (health?.key === key && Date.now() - health.at < HEALTH_TTL_MS) return health.status;
    const status = await checkWorker(settings);
    health = { key, at: Date.now(), status };
    return status;
  },
};

async function checkWorker(settings: CloudflareSettings): Promise<MachineProviderStatus> {
  try {
    const response = await fetch(`${settings.workerUrl}/health`, {
      headers: { Authorization: `Bearer ${settings.apiToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return { available: true, configured: true };
    return {
      available: true,
      configured: false,
      message:
        response.status === 401
          ? 'The Worker rejected the token.'
          : `The Worker answered ${response.status}.`,
      setup_hint: SETUP_HINT,
    };
  } catch (error) {
    return {
      available: false,
      configured: true,
      message: `The Worker is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      setup_hint: SETUP_HINT,
    };
  }
}

export default plugin;
