import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  SandboxLiveView,
  SandboxObserveResult,
  SandboxProvider,
  SandboxProviderPluginModule,
} from '@recursive/core-types/sandbox-provider';

const HELPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'provider_helper.py');

interface LocalSettings {
  pythonPath: string;
  image: string;
  virtualMachine: boolean;
}

export interface LocalComputerReadiness {
  ok: boolean;
  message: string;
  setup_hint?: string;
}

function settings(input: Record<string, unknown>): LocalSettings {
  return {
    pythonPath:
      typeof input.pythonPath === 'string' && input.pythonPath.trim()
        ? input.pythonPath.trim()
        : 'python3',
    image: typeof input.image === 'string' && input.image.trim() ? input.image.trim() : 'linux',
    virtualMachine: input.virtualMachine !== false,
  };
}

function runHelper<Result>(
  runtime: LocalSettings,
  operation: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.pythonPath, [HELPER_PATH, operation], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Local computer ${operation} timed out.`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(diagnostic || output || `Local computer ${operation} failed.`));
        return;
      }
      try {
        resolve(JSON.parse(output) as Result);
      } catch {
        reject(new Error(`Local computer returned an invalid response: ${output || diagnostic}`));
      }
    });
    child.stdin.end(
      JSON.stringify({ ...payload, image: runtime.image, vm: runtime.virtualMachine }),
    );
  });
}

function setupHint(runtime: LocalSettings): string {
  const pip = `${runtime.pythonPath} -m pip install --upgrade 'cua-sandbox>=0.4.3' cua`;
  if (process.platform === 'darwin') return `Run \`${pip}\` and \`brew install qemu\`.`;
  if (process.platform === 'win32') {
    return `Run \`${pip}\` and install QEMU with \`winget install SoftwareFreedomConservancy.QEMU\`.`;
  }
  return `Run \`${pip}\` and install QEMU with your Linux package manager.`;
}

export async function verifyLocalComputer(
  input: Record<string, unknown>,
): Promise<LocalComputerReadiness> {
  const runtime = settings(input);
  try {
    await runHelper(runtime, 'status', {}, 10_000);
    return {
      ok: true,
      message: `Cua and the ${runtime.virtualMachine ? 'virtual machine' : 'container'} runtime are ready.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      setup_hint: setupHint(runtime),
    };
  }
}

function sandboxName(input: { computer_id: string; owner_principal_id?: string | null }): string {
  const owner = input.owner_principal_id?.trim() || 'local-user';
  const digest = crypto.createHash('sha256').update(`${owner}:${input.computer_id}`).digest('hex');
  return `recursive-${digest.slice(0, 16)}`;
}

class CuaLocalSandboxProvider implements SandboxProvider {
  readonly provider_id = 'local';

  constructor(private readonly runtime: LocalSettings) {}

  async provision(input: {
    computer_id: string;
    owner_principal_id?: string | null;
  }): Promise<{ sandbox_id: string }> {
    const name = sandboxName(input);
    return runHelper(this.runtime, 'provision', { name }, 10 * 60_000);
  }

  async reconnect(sandboxId: string): Promise<{ sandbox_id: string }> {
    return runHelper(this.runtime, 'reconnect', { name: sandboxId }, 5 * 60_000);
  }

  async stop(sandboxId: string): Promise<void> {
    await runHelper(this.runtime, 'stop', { name: sandboxId });
  }

  async destroy(sandboxId: string): Promise<void> {
    await runHelper(this.runtime, 'destroy', { name: sandboxId });
  }

  async observe(sandboxId: string): Promise<SandboxObserveResult> {
    return runHelper(this.runtime, 'observe', { name: sandboxId });
  }

  async act(sandboxId: string, actions: Record<string, unknown>[]): Promise<{ applied: number }> {
    return runHelper(this.runtime, 'act', { name: sandboxId, actions });
  }

  async shell(
    sandboxId: string,
    command: string,
    options: { cwd?: string; timeout_ms?: number } = {},
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return runHelper(
      this.runtime,
      'shell',
      { name: sandboxId, command, ...options },
      Math.max(30_000, options.timeout_ms ?? 30_000) + 5_000,
    );
  }

  async readFile(sandboxId: string, filePath: string): Promise<{ content: string }> {
    return runHelper(this.runtime, 'read_file', { name: sandboxId, path: filePath });
  }

  async writeSandboxFile(sandboxId: string, filePath: string, content: string): Promise<void> {
    await runHelper(this.runtime, 'write_file', {
      name: sandboxId,
      path: filePath,
      content,
    });
  }

  async liveViewUrl(
    sandboxId: string,
    options: { interactive?: boolean } = {},
  ): Promise<SandboxLiveView> {
    return runHelper(this.runtime, 'live_view', {
      name: sandboxId,
      interactive: options.interactive === true,
    });
  }
}

export const computerProvider: SandboxProviderPluginModule = {
  async status(context) {
    const readiness = await verifyLocalComputer(context.settings);
    if (readiness.ok) {
      return { available: true, configured: true };
    }
    return {
      available: false,
      configured: false,
      message: readiness.message,
      setup_hint: readiness.setup_hint,
    };
  },
  create(context) {
    return new CuaLocalSandboxProvider(settings(context.settings));
  },
};

export default computerProvider;
