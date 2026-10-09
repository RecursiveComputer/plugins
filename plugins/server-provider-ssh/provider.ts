import { spawn } from 'node:child_process';
import type {
  ServerProvider,
  ServerProviderPluginContext,
  ServerProviderPluginModule,
} from '@recursive/plugin-sdk';

/** Runs a command over ssh, optionally feeding it stdin (the install script travels there, never in argv). */
export type SshRunner = (args: string[], stdin?: string) => Promise<string>;

interface SshSettings {
  host: string;
  user: string;
  port: number;
  identityFile: string;
  address: string;
}

function settingsFrom(context: ServerProviderPluginContext): SshSettings {
  const raw = context.settings;
  const text = (key: string, fallback = '') => (typeof raw[key] === 'string' && (raw[key] as string).trim() ? (raw[key] as string).trim() : fallback);
  return {
    host: text('host'),
    user: text('user', 'root'),
    port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : 22,
    identityFile: text('identityFile'),
    address: text('address'),
  };
}

function sshRunner(settings: SshSettings): SshRunner {
  return (command, stdin) =>
    new Promise((resolve, reject) => {
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-p', String(settings.port)];
      if (settings.identityFile) args.push('-i', settings.identityFile);
      args.push(`${settings.user}@${settings.host}`, ...command);
      const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `ssh exited with ${code}`))));
      child.stdin.end(stdin ?? '');
    });
}

/** The address the server is published on and reached at. */
function publishAddress(settings: SshSettings, port: number): { publish: string; url: string } {
  if (settings.address) {
    const url = new URL(settings.address);
    return { publish: url.hostname.replace(/^\[|\]$/g, ''), url: `${url.protocol}//${url.host}` };
  }
  return { publish: '0.0.0.0', url: `http://${settings.host}:${port}` };
}

export function createSshServerProvider(settings: SshSettings, ssh: SshRunner = sshRunner(settings)): ServerProvider {
  return {
    provider_id: 'ssh',
    async create({ bootstrap }) {
      const { publish, url } = publishAddress(settings, bootstrap.port);
      // `sh -s` reads the script from stdin: its environment (keys, tokens) never reaches argv or shell history.
      await ssh([`RECURSIVE_PUBLISH=${publish}`, 'sh', '-s'], bootstrap.script);
      return { instance_id: `${settings.user}@${settings.host}:${settings.port}`, url };
    },
    async status() {
      try {
        const state = await ssh(['docker', 'inspect', '-f', '{{.State.Status}}', 'recursive-server']);
        const { url } = publishAddress(settings, 12321);
        if (state === 'running' || state === 'restarting') return { state: 'running', url };
        if (state === 'created') return { state: 'provisioning', url };
        return { state: 'stopped', url };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return /No such object|No such container/i.test(message) ? { state: 'not_found' } : { state: 'provisioning', message };
      }
    },
    async stop() {
      await ssh(['docker', 'stop', 'recursive-server']);
    },
    async start() {
      await ssh(['docker', 'start', 'recursive-server']);
    },
    async destroy() {
      await ssh(['sh', '-c', "'docker rm -f recursive-server >/dev/null 2>&1; docker volume rm recursive-data >/dev/null 2>&1; rm -rf /opt/recursive; true'"]);
    },
    async logs(_instanceId, tail = 200) {
      return ssh(['docker', 'logs', '--tail', String(tail), 'recursive-server']).catch((error) => String(error));
    },
  };
}

const plugin: ServerProviderPluginModule = {
  create: (context) => createSshServerProvider(settingsFrom(context)),
  status(context) {
    const settings = settingsFrom(context);
    if (!settings.host) {
      return { available: true, configured: false, message: 'No server set.', setup_hint: 'Enter the server\'s host and user in SSH Server settings. Its key must already let you `ssh` in.' };
    }
    return { available: true, configured: true };
  },
};

export default plugin;
