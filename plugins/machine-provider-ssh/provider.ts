import { execFile } from 'node:child_process';
import type {
  MachineInstanceState,
  MachineProvider,
  MachineProviderPluginContext,
  MachineProviderPluginModule,
} from '@recursivecomputer/plugin-sdk';

export type SshRunner = (args: string[], stdin?: string) => Promise<string>;

const runSsh: SshRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile('ssh', args, { maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout.trim());
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

interface SshSettings {
  host: string;
  port: number;
  identityFile: string;
  extraOptions: string[];
}

function settingsFrom(context: MachineProviderPluginContext): SshSettings {
  const raw = context.settings;
  return {
    host: typeof raw.host === 'string' ? raw.host.trim() : '',
    port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : 22,
    identityFile: typeof raw.identityFile === 'string' ? raw.identityFile.trim() : '',
    extraOptions: typeof raw.extraOptions === 'string' ? raw.extraOptions.split(/\s+/).filter(Boolean) : [],
  };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script is sent on stdin, never on the command line, so the enrollment
 * token does not show up in either computer's process list. It starts the
 * runner detached and records its pid for stop/status.
 */
export function launchScript(command: string, env: Record<string, string>): string {
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n');
  return `${exports}
mkdir -p "$HOME/.recursive-runner"
cat > "$HOME/.recursive-runner/start.sh" <<'RECURSIVE_START'
${exports}
${command}
RECURSIVE_START
chmod 700 "$HOME/.recursive-runner/start.sh"
if command -v setsid >/dev/null 2>&1; then
  setsid nohup sh "$HOME/.recursive-runner/start.sh" > "$HOME/.recursive-runner/runner.log" 2>&1 < /dev/null &
else
  nohup sh "$HOME/.recursive-runner/start.sh" > "$HOME/.recursive-runner/runner.log" 2>&1 < /dev/null &
fi
echo $! > "$HOME/.recursive-runner/runner.pid"
`;
}

const STOP_SCRIPT = `pid=$(cat "$HOME/.recursive-runner/runner.pid" 2>/dev/null) && kill "$pid" 2>/dev/null; pkill -f '.recursive-runner/runner.mjs' 2>/dev/null; true`;
const STATUS_SCRIPT = `pgrep -f '.recursive-runner/runner.mjs' >/dev/null && echo running || echo stopped`;

export function createSshProvider(settings: SshSettings, ssh: SshRunner = runSsh): MachineProvider {
  const base = () => {
    if (!settings.host) throw new Error('Set the SSH host in the SSH Machines plugin settings.');
    const args = ['-p', String(settings.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
    if (settings.identityFile) args.push('-i', settings.identityFile);
    for (const option of settings.extraOptions) args.push('-o', option);
    return [...args, settings.host];
  };
  return {
    provider_id: 'ssh',
    async start({ bootstrap }) {
      await ssh([...base(), 'sh -s'], launchScript(bootstrap.command, bootstrap.env));
      return { instance_id: settings.host };
    },
    async stop() {
      await ssh([...base(), 'sh -s'], STOP_SCRIPT);
    },
    async resume() {
      await ssh([...base(), 'sh -s'], 'nohup sh "$HOME/.recursive-runner/start.sh" > "$HOME/.recursive-runner/runner.log" 2>&1 < /dev/null & echo $! > "$HOME/.recursive-runner/runner.pid"');
    },
    async destroy() {
      await ssh([...base(), 'sh -s'], `${STOP_SCRIPT}\nrm -f "$HOME/.recursive-runner/start.sh" "$HOME/.recursive-runner/identity.json"`);
    },
    async status(): Promise<MachineInstanceState> {
      try {
        return (await ssh([...base(), 'sh -s'], STATUS_SCRIPT)) === 'running' ? 'running' : 'stopped';
      } catch {
        return 'not_found';
      }
    },
  };
}

const plugin: MachineProviderPluginModule = {
  create: (context) => createSshProvider(settingsFrom(context)),
  status(context) {
    const settings = settingsFrom(context);
    return settings.host
      ? { available: true, configured: true }
      : { available: true, configured: false, message: 'No SSH host set.', setup_hint: 'Set the host in SSH Machines settings.' };
  },
};

export default plugin;
