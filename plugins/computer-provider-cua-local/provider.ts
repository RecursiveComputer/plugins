import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  SandboxObserveOptions,
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

interface LocalStatusResult {
  ready: true;
  guest_arch: string | null;
  emulated: boolean;
}

type HelperResponse = {
  id: number;
  result?: unknown;
  error?: string;
};

type PendingHelperRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

const helperClients = new Map<string, PersistentHelperClient>();

export function sanitizeLocalComputerDiagnostic(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^Credential helper 'docker-credential-[^']+' failed:/.test(line.trim()))
    .join('\n')
    .trim();
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

class PersistentHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout = '';
  private stderr = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingHelperRequest>();

  constructor(
    private readonly pythonPath: string,
    private readonly onClose: () => void,
  ) {}

  request<Result>(
    operation: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Result> {
    const child = this.process();
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local computer ${operation} timed out.`));
        this.close();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, operation, payload })}\n`, (error) => {
        if (!error) return;
        this.fail(error);
      });
    });
  }

  private process(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.pythonPath, [HELPER_PATH, 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdout = '';
    this.stderr = '';
    child.stdout.on('data', (chunk: Buffer) => this.readStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-8_192);
    });
    child.once('error', (error) => this.fail(error));
    child.once('close', (code) => {
      const diagnostic = sanitizeLocalComputerDiagnostic(this.stderr);
      this.fail(
        new Error(
          diagnostic ||
            `Local computer helper stopped${code === null ? '' : ` with code ${code}`}.`,
        ),
      );
    });
    return child;
  }

  private readStdout(chunk: Buffer): void {
    this.stdout += chunk.toString('utf8');
    let newline = this.stdout.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line) this.resolveLine(line);
      newline = this.stdout.indexOf('\n');
    }
  }

  private resolveLine(line: string): void {
    let response: HelperResponse;
    try {
      response = JSON.parse(line) as HelperResponse;
    } catch {
      this.fail(new Error(`Local computer returned an invalid response: ${line.slice(0, 500)}`));
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.result);
  }

  private close(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    this.onClose();
  }

  private fail(error: Error): void {
    if (!this.child && this.pending.size === 0) return;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.onClose();
  }
}

function runHelper<Result>(
  runtime: LocalSettings,
  operation: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<Result> {
  let client = helperClients.get(runtime.pythonPath);
  if (!client) {
    client = new PersistentHelperClient(runtime.pythonPath, () => {
      if (helperClients.get(runtime.pythonPath) === client) {
        helperClients.delete(runtime.pythonPath);
      }
    });
    helperClients.set(runtime.pythonPath, client);
  }
  return client.request<Result>(
    operation,
    { ...payload, image: runtime.image, vm: runtime.virtualMachine },
    timeoutMs,
  );
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
    const status = await runHelper<LocalStatusResult>(runtime, 'status', {}, 10_000);
    return {
      ok: true,
      message: status.emulated
        ? 'Cua and QEMU are ready. This Apple Silicon device will run Cua’s x86_64 Linux VM with software emulation.'
        : `Cua and the ${runtime.virtualMachine ? 'virtual machine' : 'container'} runtime are ready.`,
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

  async observe(
    sandboxId: string,
    options?: SandboxObserveOptions,
  ): Promise<SandboxObserveResult> {
    return runHelper(this.runtime, 'observe', { name: sandboxId, ...(options ? { options } : {}) });
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

  async liveViewUrl(_sandboxId: string, _options: { interactive?: boolean } = {}): Promise<null> {
    return null;
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
