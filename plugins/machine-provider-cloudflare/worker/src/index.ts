import { DurableObject } from 'cloudflare:workers';
import { handle, type MachineState, type StartInput } from './routes';

/**
 * Recursive machines on Cloudflare Containers (Sandbox SDK 1.0 model): one
 * Durable Object per machine owns its container through `ctx.container`.
 *
 * - start: the container's entrypoint is the Recursive bootstrap, so the runner
 *   starts with the container and connects out to Recursive.
 * - stop: snapshot the filesystem (checkout, runner identity, installed CLIs),
 *   then stop. resume: start from that snapshot; the entrypoint runs again.
 * - keepalive: Recursive calls it while the machine has work, renewing the
 *   inactivity timer that otherwise stops an idle container.
 */

interface Env {
  MACHINES: DurableObjectNamespace<RecursiveMachine>;
  RECURSIVE_TOKEN: string;
}

interface Stored {
  command: string;
  env: Record<string, string>;
  instance: string;
  idleMs: number;
}

const DEFAULT_IDLE_MS = 60 * 60 * 1000;
/** Cloudflare caps the inactivity timeout at six hours. */
const MAX_IDLE_MS = 6 * 60 * 60 * 1000;

export class RecursiveMachine extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // The timeout does not survive a Durable Object restart (e.g. a deploy); set it again.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        const stored = await ctx.storage.get<Stored>('machine');
        await container.setInactivityTimeout(stored?.idleMs ?? DEFAULT_IDLE_MS);
      });
    }
  }

  async startMachine(input: StartInput): Promise<{ state: MachineState }> {
    const container = this.#container();
    const stored: Stored = {
      command: input.command,
      env: input.env,
      instance: input.instance ?? 'standard-2',
      idleMs: Math.min(MAX_IDLE_MS, Math.max(60_000, (input.idle_minutes ?? 60) * 60_000)),
    };
    await this.ctx.storage.put('machine', stored);
    await this.ctx.storage.delete('snapshot');
    if (container.running) await container.destroy('replaced by a new start');
    await this.#boot(stored, null);
    return this.state();
  }

  async stopMachine(): Promise<{ state: MachineState }> {
    const container = this.#container();
    if (container.running) {
      // Processes do not survive; the filesystem does. The runner hands in unfinished work when it starts again.
      const snapshot = await container.snapshotContainer({ name: 'recursive-pause' });
      await this.ctx.storage.put('snapshot', snapshot);
      await container.destroy('paused by Recursive');
    }
    return this.state();
  }

  async resumeMachine(input: Partial<StartInput>): Promise<{ state: MachineState }> {
    const container = this.#container();
    const stored = await this.ctx.storage.get<Stored>('machine');
    if (!stored) return { state: 'not_found' };
    if (container.running) return this.state();
    // A fresh enrollment rides along in case the runner lost its identity.
    const next: Stored = { ...stored, command: input.command ?? stored.command, env: { ...stored.env, ...input.env } };
    await this.ctx.storage.put('machine', next);
    await this.#boot(next, (await this.ctx.storage.get<ContainerSnapshot>('snapshot')) ?? null);
    return this.state();
  }

  async keepAlive(): Promise<{ state: MachineState }> {
    const container = this.#container();
    const stored = await this.ctx.storage.get<Stored>('machine');
    if (container.running) await container.setInactivityTimeout(stored?.idleMs ?? DEFAULT_IDLE_MS);
    return this.state();
  }

  async destroyMachine(): Promise<{ state: MachineState }> {
    const container = this.#container();
    if (container.running) await container.destroy('removed in Recursive');
    await this.ctx.storage.deleteAll();
    return { state: 'not_found' };
  }

  async state(): Promise<{ state: MachineState }> {
    if (this.ctx.container?.running) return { state: 'running' };
    return { state: (await this.ctx.storage.get('machine')) ? 'stopped' : 'not_found' };
  }

  async #boot(stored: Stored, snapshot: ContainerSnapshot | null): Promise<void> {
    const container = this.#container();
    const instance = stored.instance as NonNullable<ContainerStartupOptions['instance']>;
    container.start({
      ...(snapshot ? { containerSnapshot: snapshot } : { image: container.images.runner! }),
      instance,
      entrypoint: ['/bin/sh', '-c', stored.command],
      env: stored.env,
      // The runner connects out to Recursive and installs agent CLIs.
      enableInternet: true,
    });
    await container.setInactivityTimeout(stored.idleMs);
  }

  #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error('No container is configured for this Durable Object; check wrangler.jsonc.');
    return container;
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env.RECURSIVE_TOKEN, (machineId) => env.MACHINES.getByName(machineId));
  },
} satisfies ExportedHandler<Env>;
