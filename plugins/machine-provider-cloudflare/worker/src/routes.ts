/**
 * HTTP surface of the Recursive machines Worker. Kept free of Workers-only
 * imports so it can be tested in Node; `index.ts` binds it to the Durable Object.
 */

export interface StartInput {
  command: string;
  env: Record<string, string>;
  instance?: string;
  idle_minutes?: number;
}

export type MachineState = 'running' | 'stopped' | 'not_found';

/** The Durable Object methods the routes call (Workers RPC on the stub). */
export interface MachineStub {
  startMachine(input: StartInput): Promise<{ state: MachineState }>;
  stopMachine(): Promise<{ state: MachineState }>;
  resumeMachine(input: Partial<StartInput>): Promise<{ state: MachineState }>;
  keepAlive(): Promise<{ state: MachineState }>;
  destroyMachine(): Promise<{ state: MachineState }>;
  state(): Promise<{ state: MachineState }>;
}

export const WORKER_VERSION = 1;
const MACHINE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Compare without leaking how much of the token matched. */
export function sameToken(expected: string, given: string): boolean {
  if (!expected || expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function startInput(raw: Record<string, unknown>, partial: boolean): Partial<StartInput> {
  const out: Partial<StartInput> = {};
  if (typeof raw.command === 'string' && raw.command) out.command = raw.command;
  else if (!partial) throw new Error('command is required');
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    out.env = Object.fromEntries(Object.entries(raw.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } else if (!partial) out.env = {};
  if (typeof raw.instance === 'string' && raw.instance) out.instance = raw.instance;
  if (typeof raw.idle_minutes === 'number' && raw.idle_minutes > 0) out.idle_minutes = raw.idle_minutes;
  return out;
}

export async function handle(request: Request, token: string | undefined, stubFor: (machineId: string) => MachineStub): Promise<Response> {
  const url = new URL(request.url);
  if (!token) return json({ error: 'Set the RECURSIVE_TOKEN secret: npx wrangler secret put RECURSIVE_TOKEN' }, 500);
  const auth = request.headers.get('authorization') ?? '';
  if (!sameToken(`Bearer ${token}`, auth)) return json({ error: 'unauthorized' }, 401);
  if (url.pathname === '/health') return json({ ok: true, version: WORKER_VERSION });

  const match = /^\/machines\/([^/]+)(?:\/(start|stop|resume|keepalive))?$/.exec(url.pathname);
  if (!match || !MACHINE_ID.test(match[1]!)) return json({ error: 'not found' }, 404);
  const stub = stubFor(match[1]!);
  const action = match[2];
  try {
    if (request.method === 'GET' && !action) return json(await stub.state());
    if (request.method === 'DELETE' && !action) return json(await stub.destroyMachine());
    if (request.method === 'POST' && action === 'start') return json(await stub.startMachine(startInput(await body(request), false) as StartInput));
    if (request.method === 'POST' && action === 'stop') return json(await stub.stopMachine());
    if (request.method === 'POST' && action === 'resume') return json(await stub.resumeMachine(startInput(await body(request), true)));
    if (request.method === 'POST' && action === 'keepalive') return json(await stub.keepAlive());
    return json({ error: 'method not allowed' }, 405);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
