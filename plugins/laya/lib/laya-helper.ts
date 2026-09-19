import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundled sidecar; `serve` speaks newline-delimited JSON over stdio. */
export const LAYA_HELPER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'laya_helper.py',
);

export interface LayaHelperOptions {
  pythonPath: string;
  device?: string | null;
  maxLoaded?: number;
  preload?: boolean;
  /** Test seam: replace the bundled script (paired with `pythonPath` pointing at node). */
  helperPath?: string;
}

type HelperResponse = { id: number; result?: unknown; error?: string };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

function helperArgs(options: LayaHelperOptions): string[] {
  const args = [options.helperPath ?? LAYA_HELPER_PATH, 'serve'];
  if (options.device && options.device !== 'auto') args.push('--device', options.device);
  if (options.maxLoaded && options.maxLoaded > 1) args.push('--max-loaded', String(options.maxLoaded));
  if (options.preload) args.push('--preload');
  return args;
}

export function helperKey(options: LayaHelperOptions): string {
  return JSON.stringify([options.pythonPath, ...helperArgs(options)]);
}

/**
 * One long-lived Python process per distinct (python, device, preload) tuple. Unlike the Cua helper,
 * a request timeout does not kill the child: the first predict may still be downloading a checkpoint,
 * and killing it would restart that download on the next call. The late response is simply dropped.
 */
export class LayaHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout = '';
  private stderr = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(
    private readonly options: LayaHelperOptions,
    private readonly onClose: () => void = () => {},
  ) {}

  request<Result>(operation: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Result> {
    const child = this.process();
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Laya ${operation} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as Result), reject, timer });
      child.stdin.write(`${JSON.stringify({ id, operation, payload })}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  /** Last stderr tail; surfaces pip/torch diagnostics in status messages. */
  diagnostics(): string {
    return this.stderr.trim();
  }

  close(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    this.rejectAll(new Error('Laya helper closed.'));
    this.onClose();
  }

  private process(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.options.pythonPath, helperArgs(this.options), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
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
      if (this.child !== child) return;
      const diagnostic = lastMeaningfulLine(this.stderr);
      this.fail(new Error(diagnostic || `Laya helper stopped${code === null ? '' : ` with code ${code}`}.`));
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
      this.fail(new Error(`Laya helper returned an invalid response: ${line.slice(0, 500)}`));
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.result);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill('SIGTERM');
    this.rejectAll(error);
    this.onClose();
  }
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Python tracebacks end with the exception line (`ModuleNotFoundError: …`), which is the useful part;
  // fall back to the last line when nothing looks like an exception.
  const exceptionLine = [...lines].reverse().find((line) => /error|exception/i.test(line));
  return exceptionLine ?? (lines.length ? lines[lines.length - 1]! : '');
}

const clients = new Map<string, LayaHelperClient>();

/** Shared persistent client; recreated automatically after the process exits. */
export function getLayaHelperClient(options: LayaHelperOptions): LayaHelperClient {
  const key = helperKey(options);
  let client = clients.get(key);
  if (!client) {
    const created = new LayaHelperClient(options, () => {
      if (clients.get(key) === created) clients.delete(key);
    });
    clients.set(key, created);
    client = created;
  }
  return client;
}

export function closeAllLayaHelperClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
