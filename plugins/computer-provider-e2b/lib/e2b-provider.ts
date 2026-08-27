import { Sandbox } from '@e2b/desktop';

import type {
  SandboxLiveView,
  SandboxObserveResult,
  SandboxProvider,
} from '@recursive/core-types/sandbox-provider';

export interface E2bComputerSettings {
  apiKey: string;
  template: string;
  idleTimeoutMs: number;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

export class E2bSandboxProvider implements SandboxProvider {
  readonly provider_id = 'e2b';
  private readonly connections = new Map<string, Promise<Sandbox>>();

  constructor(private readonly settings: E2bComputerSettings) {}

  private connectionOptions() {
    return {
      apiKey: this.settings.apiKey,
      timeoutMs: this.settings.idleTimeoutMs,
    };
  }

  private async connect(sandboxId: string): Promise<Sandbox> {
    const existing = this.connections.get(sandboxId);
    if (existing) {
      try {
        const sandbox = await existing;
        if (await sandbox.isRunning()) {
          await sandbox.setTimeout(this.settings.idleTimeoutMs);
          return sandbox;
        }
      } catch {
        this.connections.delete(sandboxId);
      }
    }
    const pending = Sandbox.connect(sandboxId, this.connectionOptions());
    this.connections.set(sandboxId, pending);
    try {
      const sandbox = await pending;
      await sandbox.setTimeout(this.settings.idleTimeoutMs);
      return sandbox;
    } catch (error) {
      this.connections.delete(sandboxId);
      throw error;
    }
  }

  async provision(input: {
    computer_id: string;
    owner_principal_id?: string | null;
    session_id?: string | null;
    agent_id?: string | null;
  }): Promise<{ sandbox_id: string }> {
    const sandbox = await Sandbox.create(this.settings.template, {
      ...this.connectionOptions(),
      lifecycle: { onTimeout: { action: 'pause', keepMemory: true }, autoResume: false },
      metadata: {
        recursive_kind: 'shared-user-computer',
        recursive_computer_id: input.computer_id,
      },
    });
    this.connections.set(sandbox.sandboxId, Promise.resolve(sandbox));
    return { sandbox_id: sandbox.sandboxId };
  }

  async reconnect(sandboxId: string): Promise<{ sandbox_id: string }> {
    await this.connect(sandboxId);
    return { sandbox_id: sandboxId };
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    try {
      await sandbox.stream.stop();
    } catch {}
    await sandbox.pause({ keepMemory: true, apiKey: this.settings.apiKey });
    this.connections.delete(sandboxId);
  }

  async destroy(sandboxId: string): Promise<void> {
    this.connections.delete(sandboxId);
    await Sandbox.kill(sandboxId, { apiKey: this.settings.apiKey });
  }

  async observe(sandboxId: string): Promise<SandboxObserveResult> {
    const sandbox = await this.connect(sandboxId);
    const [image, size] = await Promise.all([sandbox.screenshot(), sandbox.getScreenSize()]);
    return {
      image_base64: Buffer.from(image).toString('base64'),
      width: size.width,
      height: size.height,
    };
  }

  async act(sandboxId: string, actions: Record<string, unknown>[]): Promise<{ applied: number }> {
    const sandbox = await this.connect(sandboxId);
    let applied = 0;
    for (const action of actions) {
      const type = nonEmptyString(action.type, 'action.type');
      if (type === 'click') {
        const x = finiteNumber(action.x, 'action.x');
        const y = finiteNumber(action.y, 'action.y');
        const button =
          action.button === 'right' || action.button === 'middle' ? action.button : 'left';
        if (button === 'right') await sandbox.rightClick(x, y);
        else if (button === 'middle') await sandbox.middleClick(x, y);
        else if (action.double === true) await sandbox.doubleClick(x, y);
        else await sandbox.leftClick(x, y);
      } else if (type === 'move') {
        await sandbox.moveMouse(
          finiteNumber(action.x, 'action.x'),
          finiteNumber(action.y, 'action.y'),
        );
      } else if (type === 'drag') {
        await sandbox.drag(
          [
            finiteNumber(action.from_x, 'action.from_x'),
            finiteNumber(action.from_y, 'action.from_y'),
          ],
          [finiteNumber(action.to_x, 'action.to_x'), finiteNumber(action.to_y, 'action.to_y')],
        );
      } else if (type === 'scroll') {
        const amount = Math.abs(finiteNumber(action.amount ?? 3, 'action.amount'));
        const direction = action.direction === 'up' ? 'up' : 'down';
        await sandbox.scroll(direction, amount);
      } else if (type === 'type') {
        await sandbox.write(nonEmptyString(action.text, 'action.text'));
      } else if (type === 'key') {
        const keys = Array.isArray(action.keys)
          ? action.keys.map((key) => nonEmptyString(key, 'action.keys'))
          : nonEmptyString(action.key, 'action.key');
        await sandbox.press(keys);
      } else if (type === 'wait') {
        await sandbox.wait(finiteNumber(action.ms, 'action.ms'));
      } else if (type === 'open') {
        await sandbox.open(nonEmptyString(action.target, 'action.target'));
      } else if (type === 'launch') {
        await sandbox.launch(
          nonEmptyString(action.application, 'action.application'),
          typeof action.uri === 'string' ? action.uri : undefined,
        );
      } else {
        throw new Error(`Unsupported computer action: ${type}`);
      }
      applied += 1;
    }
    return { applied };
  }

  async shell(
    sandboxId: string,
    command: string,
    options: { cwd?: string; timeout_ms?: number } = {},
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    const sandbox = await this.connect(sandboxId);
    const result = await sandbox.commands.run(command, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.timeout_ms ? { timeoutMs: options.timeout_ms } : {}),
    });
    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readFile(sandboxId: string, path: string): Promise<{ content: string }> {
    const sandbox = await this.connect(sandboxId);
    return { content: await sandbox.files.read(path) };
  }

  async writeSandboxFile(sandboxId: string, path: string, content: string): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    await sandbox.files.write(path, content);
  }

  async liveViewUrl(
    sandboxId: string,
    options: { interactive?: boolean } = {},
  ): Promise<SandboxLiveView> {
    const sandbox = await this.connect(sandboxId);
    await sandbox.stream.start({ requireAuth: true });
    const authKey = sandbox.stream.getAuthKey();
    const interactive = options.interactive === true;
    return {
      url: sandbox.stream.getUrl({
        authKey,
        autoConnect: true,
        resize: 'scale',
        viewOnly: !interactive,
      }),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      interactive,
    };
  }
}
