import crypto from 'node:crypto';

import { Sandbox } from '@e2b/desktop';
import sharp from 'sharp';

import type {
  SandboxLiveView,
  SandboxObserveOptions,
  SandboxObserveRegion,
  SandboxObserveResult,
  SandboxProvider,
} from '@recursive/plugin-sdk';

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

interface NormalizedObserveOptions {
  format: 'png' | 'webp';
  quality: number;
  maxRasterWidth: number | undefined;
  maxRasterHeight: number | undefined;
  sourceRegion: SandboxObserveRegion;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.round(value));
}

function normalizeSourceRegion(
  requested: SandboxObserveRegion | null | undefined,
  desktopWidth: number,
  desktopHeight: number,
): SandboxObserveRegion {
  if (!requested) return { x: 0, y: 0, width: desktopWidth, height: desktopHeight };
  const values = [requested.x, requested.y, requested.width, requested.height];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('source_region must contain finite coordinates and dimensions.');
  }
  if (requested.width <= 0 || requested.height <= 0) {
    throw new Error('source_region dimensions must be greater than zero.');
  }
  const left = Math.max(0, Math.min(desktopWidth, Math.floor(requested.x)));
  const top = Math.max(0, Math.min(desktopHeight, Math.floor(requested.y)));
  const right = Math.max(0, Math.min(desktopWidth, Math.ceil(requested.x + requested.width)));
  const bottom = Math.max(0, Math.min(desktopHeight, Math.ceil(requested.y + requested.height)));
  if (right <= left || bottom <= top) {
    throw new Error('source_region must intersect the desktop.');
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeObserveOptions(
  options: SandboxObserveOptions | undefined,
  desktopWidth: number,
  desktopHeight: number,
): NormalizedObserveOptions {
  return {
    format: options?.format === 'webp' ? 'webp' : 'png',
    quality:
      typeof options?.quality === 'number' && Number.isFinite(options.quality)
        ? Math.min(100, Math.max(1, Math.round(options.quality)))
        : 80,
    maxRasterWidth: positiveInteger(options?.max_raster_width),
    maxRasterHeight: positiveInteger(options?.max_raster_height),
    sourceRegion: normalizeSourceRegion(options?.source_region, desktopWidth, desktopHeight),
  };
}

async function optimizeDesktopFrame(
  image: Buffer,
  desktopWidth: number,
  desktopHeight: number,
  options: SandboxObserveOptions | undefined,
): Promise<Omit<SandboxObserveResult, 'width' | 'height' | 'desktop_width' | 'desktop_height'>> {
  const request = normalizeObserveOptions(options, desktopWidth, desktopHeight);
  let pipeline = sharp(image).extract({
    left: request.sourceRegion.x,
    top: request.sourceRegion.y,
    width: request.sourceRegion.width,
    height: request.sourceRegion.height,
  });
  if (request.maxRasterWidth || request.maxRasterHeight) {
    pipeline = pipeline.resize({
      ...(request.maxRasterWidth ? { width: request.maxRasterWidth } : {}),
      ...(request.maxRasterHeight ? { height: request.maxRasterHeight } : {}),
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const encoded =
    request.format === 'webp'
      ? await pipeline.webp({ quality: request.quality }).toBuffer({ resolveWithObject: true })
      : await pipeline.png().toBuffer({ resolveWithObject: true });
  return {
    image_base64: encoded.data.toString('base64'),
    mime_type: request.format === 'webp' ? 'image/webp' : 'image/png',
    raster_width: encoded.info.width,
    raster_height: encoded.info.height,
    source_region: request.sourceRegion,
    dedupe_key: crypto.createHash('sha256').update(encoded.data).digest('hex'),
  };
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

  async observe(
    sandboxId: string,
    options?: SandboxObserveOptions,
  ): Promise<SandboxObserveResult> {
    const sandbox = await this.connect(sandboxId);
    const [image, size] = await Promise.all([sandbox.screenshot(), sandbox.getScreenSize()]);
    return {
      width: size.width,
      height: size.height,
      desktop_width: size.width,
      desktop_height: size.height,
      ...(await optimizeDesktopFrame(Buffer.from(image), size.width, size.height, options)),
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
