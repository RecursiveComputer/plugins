import { spawn } from 'node:child_process';
import type {
  ServerProvider,
  ServerProviderPluginContext,
  ServerProviderPluginModule,
} from '@recursivecomputer/plugin-sdk';

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

export function createSshServerProvider(settings: SshSettings, ssh: SshRunner = sshRunner(settings)): SshServerProvider {
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
    async hostStorage() {
      return parseHostStorage(await ssh(['sh', '-s'], HOST_STORAGE_SCRIPT));
    },
    async reclaimHostStorage(_instanceId, plan) {
      const result: HostReclaimResult = { removed: [], failed: [], build_cache_freed_bytes: null };
      // Listed again: an image is removed only while it is still a Recursive one no container uses.
      const current = new Map(parseHostStorage(await ssh(['sh', '-s'], HOST_STORAGE_SCRIPT)).images.map((image) => [image.id, image]));
      for (const id of plan.image_ids) {
        const image = current.get(id);
        if (!image) result.failed.push({ id, error: 'Not a Recursive image on the host now.' });
        else if (image.containers.length) result.failed.push({ id, error: `In use by ${image.containers.join(', ')}.` });
        else {
          // Its tags, or its id when it has none: an id with several tags is refused without --force.
          const refs = image.tags.length ? image.tags : [image.id];
          if (!refs.every((ref) => SAFE_REF.test(ref))) {
            result.failed.push({ id, error: 'Unexpected image name.' });
            continue;
          }
          try {
            await ssh(['docker', 'image', 'rm', ...refs]);
            result.removed.push(id);
          } catch (error) {
            result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const keep = plan.build_cache_keep_bytes;
      if (typeof keep === 'number' && Number.isSafeInteger(keep) && keep >= 0) {
        try {
          let output: string;
          try {
            output = await ssh(['docker', 'builder', 'prune', '-f', '--keep-storage', String(keep)]);
          } catch (error) {
            // Newer buildx names it --reserved-space.
            if (!/unknown flag|flag provided but not defined/i.test(error instanceof Error ? error.message : String(error))) throw error;
            output = await ssh(['docker', 'builder', 'prune', '-f', '--reserved-space', String(keep)]);
          }
          const total = /Total(?: reclaimed space)?:\s*([\d.]+\s*[a-zA-Z]+)/.exec(output);
          result.build_cache_freed_bytes = total ? parseHumanSize(total[1]) : 0;
        } catch (error) {
          result.failed.push({ id: 'build-cache', error: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    },
  };
}

// ── Docker on the host ──
// Local shapes: the published SDK this plugin also builds against may not name them yet.

interface HostImage {
  id: string;
  repository: string | null;
  tags: string[];
  bytes: number;
  created_ms: number;
  containers: string[];
}

interface HostStorage {
  images: HostImage[];
  build_cache: { bytes: number; reclaimable_bytes: number } | null;
}

interface HostReclaimResult {
  removed: string[];
  failed: Array<{ id: string; error: string }>;
  build_cache_freed_bytes: number | null;
}

export type SshServerProvider = ServerProvider & {
  hostStorage(instanceId: string): Promise<HostStorage>;
  reclaimHostStorage(instanceId: string, plan: { image_ids: string[]; build_cache_keep_bytes: number | null }): Promise<HostReclaimResult>;
};

/** Repositories Recursive builds or pulls: the server image and the runner images. */
const RECURSIVE_REPOSITORY = /(^|\/)recursive[^/]*$/;
/** The server image's entrypoint: how an untagged image built on the host is known as Recursive's. */
const SERVER_ENTRYPOINT = '/opt/recursive/entrypoint.sh';
const SAFE_REF = /^[A-Za-z0-9._\/:@-]+$/;

/**
 * Read-only. Sections: the image each container uses, every image's tags and size, and the
 * daemon's disk usage for images and the build cache only (`docker system df` would also
 * walk every volume, the server's data among them). API 1.44 (Docker 25+) has the type filter;
 * an older daemon refuses the path rather than walking volumes, and `docker buildx du` stands in
 * (also without curl).
 */
export const HOST_STORAGE_SCRIPT = String.raw`set -u
docker version --format '{{.Server.Version}}' >/dev/null || exit 1
echo '@containers'
docker ps -aq --no-trunc | xargs -r docker container inspect --format '{{.Image}} {{.Name}}'
echo '@images'
docker image ls -q --no-trunc | sort -u | xargs -r docker image inspect --format '{{json .Id}} {{.Size}} {{json .Created}} {{json .RepoTags}} {{json .RepoDigests}} {{with .Config}}{{json .Entrypoint}}{{else}}null{{end}}'
echo '@df'
sock=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed -n 's#^unix://##p')
[ -n "$sock" ] || sock=/var/run/docker.sock
command -v curl >/dev/null && curl -fsS --max-time 60 --unix-socket "$sock" 'http://localhost/v1.44/system/df?type=image&type=build-cache' 2>/dev/null
echo
echo '@buildx'
docker buildx du 2>/dev/null | tail -n 4
exit 0
`;

const HUMAN_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };

/** Docker's human sizes ("1.23GB", "512MB", "0B"). */
export function parseHumanSize(text: string): number {
  const match = /^\s*([\d.]+)\s*([a-zA-Z]+)/.exec(text);
  return match ? Math.round(Number(match[1]) * (HUMAN_UNITS[match[2].toUpperCase()] ?? 0)) : 0;
}

/** `registry:5000/name:tag` → `registry:5000/name`; `name@sha256:…` → `name`. */
function repositoryOf(ref: string): string {
  const at = ref.indexOf('@');
  if (at >= 0) return ref.slice(0, at);
  const colon = ref.lastIndexOf(':');
  return colon > ref.lastIndexOf('/') ? ref.slice(0, colon) : ref;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/**
 * Recursive's images, from the listing script. An image is Recursive's when every name it
 * has is in a Recursive repository, or, with no name at all, when it is the server image
 * (its entrypoint). An image that also carries another repository's tag is left out.
 */
export function parseHostStorage(output: string): HostStorage {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of output.split('\n')) {
    const header = /^@(containers|images|df|buildx)$/.exec(line.trim());
    if (header) sections.set(header[1], (current = []));
    else current?.push(line);
  }

  const containers = new Map<string, string[]>();
  for (const line of sections.get('containers') ?? []) {
    const [image, name] = line.trim().split(/\s+/);
    if (image && name) containers.set(image, [...(containers.get(image) ?? []), name.replace(/^\//, '')]);
  }

  const df = json((sections.get('df') ?? []).join('\n').trim()) as
    | { Images?: Array<{ Id?: unknown; Size?: unknown; SharedSize?: unknown }>; BuildCache?: Array<{ Size?: unknown; InUse?: unknown; Shared?: unknown }> }
    | undefined;
  const unique = new Map<string, number>();
  for (const row of df?.Images ?? []) {
    if (typeof row.Id === 'string' && typeof row.Size === 'number' && typeof row.SharedSize === 'number' && row.SharedSize >= 0) {
      unique.set(row.Id, Math.max(0, row.Size - row.SharedSize));
    }
  }

  const images: HostImage[] = [];
  for (const line of sections.get('images') ?? []) {
    // {{json .Id}} {{.Size}} {{json .Created}} {{json .RepoTags}} {{json .RepoDigests}} {{json .Entrypoint}}
    const match = /^("[^"]+")\s+(\d+)\s+("[^"]*"|null)\s+(\[.*?\]|null)\s+(\[.*?\]|null)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const id = json(match[1]);
    if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id)) continue;
    const tags = strings(json(match[4])).filter((tag) => !tag.startsWith('<none>'));
    const names = tags.length ? tags : strings(json(match[5]));
    const repositories = [...new Set(names.map(repositoryOf))];
    if (repositories.length) {
      if (!repositories.every((repository) => RECURSIVE_REPOSITORY.test(repository))) continue;
    } else if (!strings(json(match[6])).some((part) => part.includes(SERVER_ENTRYPOINT))) {
      continue;
    }
    const created = Date.parse(String(json(match[3]) ?? ''));
    images.push({
      id,
      repository: repositories[0] ?? null,
      tags,
      bytes: unique.get(id) ?? Number(match[2]),
      created_ms: Number.isFinite(created) ? created : 0,
      containers: containers.get(id) ?? [],
    });
  }

  let buildCache: HostStorage['build_cache'] = null;
  if (Array.isArray(df?.BuildCache)) {
    let bytes = 0;
    let reclaimable = 0;
    for (const row of df.BuildCache) {
      if (typeof row.Size !== 'number' || row.Shared === true) continue;
      bytes += row.Size;
      if (row.InUse !== true) reclaimable += row.Size;
    }
    buildCache = { bytes, reclaimable_bytes: reclaimable };
  } else {
    const text = (sections.get('buildx') ?? []).join('\n');
    const total = /^Total:\s*(\S+)/m.exec(text);
    const reclaimable = /^Reclaimable:\s*(\S+)/m.exec(text);
    if (total) buildCache = { bytes: parseHumanSize(total[1]), reclaimable_bytes: reclaimable ? parseHumanSize(reclaimable[1]) : parseHumanSize(total[1]) };
  }
  return { images, build_cache: buildCache };
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
