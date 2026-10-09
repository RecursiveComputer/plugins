import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import type { ServerProvider, ServerProviderPluginModule } from '@recursivecomputer/plugin-sdk';

/** Runs a docker CLI command; env carries secret values so they never appear in process listings. */
export type DockerRunner = (args: string[], env?: Record<string, string>) => Promise<string>;

const runDocker: DockerRunner = (args, env = {}) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
  });

/** A free port on this computer for the container's server port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

const LABEL = 'computer.recursive.server';

export function createDockerServerProvider(docker: DockerRunner = runDocker, pickPort: () => Promise<number> = freePort): ServerProvider {
  return {
    provider_id: 'docker',
    async create({ server_id, bootstrap }) {
      const name = `recursive-${server_id.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
      const port = await pickPort();
      const args = [
        'run', '-d', '--name', name, '--label', `${LABEL}=${server_id}`, '--restart', 'unless-stopped',
        // Only this computer reaches it directly; phones go through the passkey account's routes.
        '-p', `127.0.0.1:${port}:${bootstrap.port}`,
        '-v', `${name}-data:/data`,
      ];
      for (const key of Object.keys(bootstrap.env)) args.push('-e', key);
      args.push(bootstrap.image);
      const id = await docker(args, bootstrap.env);
      return { instance_id: id.split('\n').pop()!.slice(0, 64), url: `http://127.0.0.1:${port}` };
    },
    async status(instanceId) {
      try {
        const [state, ports] = (await docker(['inspect', '-f', '{{.State.Status}}|{{json .NetworkSettings.Ports}}', instanceId])).split('|');
        const binding = Object.values(JSON.parse(ports || '{}') as Record<string, Array<{ HostIp: string; HostPort: string }> | null>).flat().find(Boolean);
        const url = binding ? `http://127.0.0.1:${binding.HostPort}` : null;
        if (state === 'running' || state === 'restarting') return { state: 'running', url };
        if (state === 'created') return { state: 'provisioning', url };
        if (state === 'exited' || state === 'paused') return { state: 'stopped', url };
        return { state: 'error', url, message: `Container is ${state}.` };
      } catch {
        return { state: 'not_found' };
      }
    },
    async stop(instanceId) {
      await docker(['stop', instanceId]);
    },
    async start(instanceId) {
      await docker(['start', instanceId]);
    },
    async destroy(instanceId) {
      const volume = await docker(['inspect', '-f', '{{range .Mounts}}{{.Name}}{{end}}', instanceId]).catch(() => '');
      await docker(['rm', '-f', instanceId]).catch((error) => {
        if (!/No such container/i.test(String(error))) throw error;
      });
      if (volume) await docker(['volume', 'rm', volume]).catch(() => undefined);
    },
    async logs(instanceId, tail = 200) {
      return docker(['logs', '--tail', String(tail), instanceId]).catch((error) => String(error));
    },
  };
}

const plugin: ServerProviderPluginModule = {
  create: () => createDockerServerProvider(),
  async status() {
    try {
      await runDocker(['version', '--format', '{{.Server.Version}}']);
      return { available: true, configured: true };
    } catch {
      return {
        available: false,
        configured: false,
        message: 'Docker is not running on this computer.',
        setup_hint: 'Install and start Docker Desktop, OrbStack, Colima, or Docker Engine.',
      };
    }
  },
};

export default plugin;
