import crypto from 'node:crypto';
import type { StorageInfo, SyncManifest, SyncProvider } from '@recursivecomputer/plugin-sdk';

const MANIFEST_KEY = '.sync-manifest.json';
const TIMEOUT_MS = 60_000;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const AZURE_VERSION = '2021-08-06';
const DEFAULT_BUCKET = 'recursive-backups';

type Preset = 'r2' | 'aws' | 'gcs' | 'azure' | 'b2' | 'wasabi' | 'do' | 'hetzner' | 's3';

interface S3Target {
  kind: 's3';
  endpoint: URL;
  pathStyle: boolean;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface AzureTarget {
  kind: 'azure';
  endpoint: URL;
  account: string;
  key: Buffer;
  container: string;
}

type Target = S3Target | AzureTarget;

function text(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function need(config: Record<string, unknown>, key: string, label: string): string {
  const value = text(config, key);
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeKey(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function cloudflare<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}, api = CLOUDFLARE_API): Promise<{ ok: boolean; result: T | null; code: number | null; message: string }> {
  const response = await fetch(`${api}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> };
  const error = json.errors?.[0];
  return { ok: response.ok && json.success !== false, result: json.result ?? null, code: error?.code ?? null, message: error?.message ?? `Cloudflare answered ${response.status}.` };
}

export async function cloudflareR2Credentials(config: Record<string, unknown>): Promise<{ accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint: string }> {
  const token = need(config, 'api_token', 'A Cloudflare API token');
  const api = text(config, 'cloudflare_api') || CLOUDFLARE_API;
  let accountId = text(config, 'account_id');
  let tokenId = '';
  const user = await cloudflare<{ id: string; status: string }>(token, '/user/tokens/verify', {}, api);
  if (user.ok && user.result?.id) tokenId = user.result.id;
  if (!accountId) {
    const accounts = await cloudflare<Array<{ id: string; name: string }>>(token, '/accounts', {}, api);
    const list = accounts.result ?? [];
    if (!accounts.ok || !list.length) throw new Error('This Cloudflare token cannot see an account. Add the Account ID from the Cloudflare dashboard, or create the token from the R2 page.');
    if (list.length > 1) throw new Error(`This token can reach ${list.length} Cloudflare accounts (${list.map((item) => item.name).join(', ')}). Add the Account ID of the one to use.`);
    accountId = list[0]!.id;
  }
  if (!tokenId) {
    const owned = await cloudflare<{ id: string; status: string }>(token, `/accounts/${accountId}/tokens/verify`, {}, api);
    if (!owned.ok || !owned.result?.id) throw new Error(`Cloudflare did not accept this token: ${owned.message}`);
    tokenId = owned.result.id;
  }
  const bucket = text(config, 'bucket') || DEFAULT_BUCKET;
  const created = await cloudflare(token, `/accounts/${accountId}/r2/buckets`, { method: 'POST', body: { name: bucket } }, api);
  if (!created.ok && created.code !== 10004 && !/already exists/i.test(created.message)) {
    throw new Error(`Could not make the R2 bucket "${bucket}": ${created.message} The token needs R2 edit permission.`);
  }
  return {
    accountId,
    bucket,
    accessKeyId: tokenId,
    secretAccessKey: sha256Hex(token),
    endpoint: text(config, 'endpoint') || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

function s3Target(preset: Preset, config: Record<string, unknown>): S3Target {
  const bucket = need(config, 'bucket', 'The bucket name');
  const region = text(config, 'region');
  const custom = text(config, 'endpoint');
  const endpointFor: Record<Exclude<Preset, 'azure' | 'r2'>, () => string> = {
    aws: () => `https://s3.${region || 'us-east-1'}.amazonaws.com`,
    gcs: () => 'https://storage.googleapis.com',
    b2: () => `https://s3.${need(config, 'region', 'The Backblaze region (for example us-west-004)')}.backblazeb2.com`,
    wasabi: () => `https://s3.${region || 'us-east-1'}.wasabisys.com`,
    do: () => `https://${need(config, 'region', 'The Spaces region (for example nyc3)')}.digitaloceanspaces.com`,
    hetzner: () => `https://${need(config, 'region', 'The location (fsn1, nbg1 or hel1)')}.your-objectstorage.com`,
    s3: () => need(config, 'endpoint', 'The endpoint URL'),
  };
  const endpoint = new URL(custom || endpointFor[preset as Exclude<Preset, 'azure' | 'r2'>]());
  return {
    kind: 's3',
    endpoint,
    pathStyle: preset !== 'aws' || !!custom,
    bucket,
    region: preset === 'gcs' ? 'auto' : region || (preset === 'aws' || preset === 'wasabi' ? 'us-east-1' : 'auto'),
    accessKeyId: need(config, 'access_key_id', 'The access key ID'),
    secretAccessKey: need(config, 'secret_access_key', 'The secret access key'),
  };
}

async function s3Fetch(target: S3Target, method: string, key: string, body?: Buffer): Promise<Response> {
  const base = target.pathStyle ? target.endpoint : new URL(`${target.endpoint.protocol}//${target.bucket}.${target.endpoint.host}`);
  const path = `${base.pathname.replace(/\/$/, '')}${target.pathStyle ? `/${target.bucket}` : ''}/${encodeKey(key)}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const payload = sha256Hex(body ?? '');
  const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate };
  if (body) headers['content-type'] = 'application/octet-stream';
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'), payload].join('\n');
  const scope = `${day}/${target.region}/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${target.secretAccessKey}`, day), target.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')).digest('hex');
  const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
  return fetch(`${base.protocol}//${base.host}${path}`, {
    method,
    headers: { ...sent, Authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function azureTarget(config: Record<string, unknown>): AzureTarget {
  const account = need(config, 'account_name', 'The storage account name');
  const key = Buffer.from(need(config, 'account_key', 'The storage account key'), 'base64');
  if (!key.length) throw new Error('The storage account key is not valid base64.');
  return {
    kind: 'azure',
    endpoint: new URL(text(config, 'endpoint') || `https://${account}.blob.core.windows.net`),
    account,
    key,
    container: text(config, 'container') || DEFAULT_BUCKET,
  };
}

export function azureSignature(input: { account: string; key: Buffer; method: string; path: string; length: number; contentType: string; headers: Record<string, string>; query?: Record<string, string> }): string {
  const msHeaders = Object.keys(input.headers).filter((name) => name.startsWith('x-ms-')).sort().map((name) => `${name}:${input.headers[name]}\n`).join('');
  const query = Object.entries(input.query ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `\n${name.toLowerCase()}:${value}`).join('');
  const toSign = [input.method, '', '', input.length ? String(input.length) : '', '', input.contentType, '', '', '', '', '', ''].join('\n') + `\n${msHeaders}/${input.account}${input.path}${query}`;
  return `SharedKey ${input.account}:${crypto.createHmac('sha256', input.key).update(toSign, 'utf8').digest('base64')}`;
}

async function azureFetch(target: AzureTarget, method: string, key: string | null, body?: Buffer, query?: Record<string, string>): Promise<Response> {
  const path = `${target.endpoint.pathname.replace(/\/$/, '')}/${target.container}${key === null ? '' : `/${encodeKey(key)}`}`;
  const headers: Record<string, string> = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AZURE_VERSION };
  const contentType = body ? 'application/octet-stream' : '';
  if (body && key !== null) headers['x-ms-blob-type'] = 'BlockBlob';
  const signed = azureSignature({ account: target.account, key: target.key, method, path, length: body?.length ?? 0, contentType, headers, query });
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return fetch(`${target.endpoint.protocol}//${target.endpoint.host}${path}${search}`, {
    method,
    headers: { ...headers, ...(contentType ? { 'Content-Type': contentType } : {}), Authorization: signed },
    body: body ? new Uint8Array(body) : method === 'PUT' ? new Uint8Array(0) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export class CloudStorageProvider implements SyncProvider {
  readonly id = 'cloud-storage';
  readonly name = 'Cloud Storage';
  readonly description = 'Cloudflare R2, Amazon S3, Google Cloud Storage, Azure Blob Storage, Backblaze B2, Wasabi, DigitalOcean Spaces and Hetzner Object Storage.';

  private target: Target | null = null;
  private prefix = 'recursive-backups/';
  private ready: Promise<void> | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const prefix = text(config, 'prefix');
    this.prefix = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : 'recursive-backups/';
    const preset = (text(config, 'preset') || 's3') as Preset;
    if (preset === 'azure') {
      this.target = azureTarget(config);
      return;
    }
    if (preset === 'r2' && text(config, 'api_token') && !text(config, 'access_key_id')) {
      this.ready = cloudflareR2Credentials(config).then((r2) => {
        this.target = { kind: 's3', endpoint: new URL(r2.endpoint), pathStyle: true, bucket: r2.bucket, region: 'auto', accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey };
      });
      return;
    }
    this.target = s3Target(preset === 'r2' ? 's3' : preset, preset === 'r2' && !text(config, 'endpoint') ? { ...config, endpoint: `https://${need(config, 'account_id', 'The Cloudflare account ID')}.r2.cloudflarestorage.com` } : config);
  }

  private async open(): Promise<Target> {
    if (this.ready) await this.ready;
    if (!this.target) throw new Error('Cloud Storage is not set up.');
    return this.target;
  }

  private async request(method: string, key: string, body?: Buffer): Promise<Response> {
    const target = await this.open();
    if (target.kind === 's3') return s3Fetch(target, method, this.prefix + key, body);
    const response = await azureFetch(target, method, this.prefix + key, body);
    if (method !== 'PUT' || response.status !== 404) return response;
    const created = await azureFetch(target, 'PUT', null, undefined, { restype: 'container' });
    if (!created.ok && created.status !== 409) return created;
    return azureFetch(target, method, this.prefix + key, body);
  }

  async dispose(): Promise<void> {
    this.target = null;
    this.ready = null;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.request('HEAD', '__probe__');
      if (response.status === 200 || response.status === 404) return { ok: true };
      if (response.status === 401 || response.status === 403) return { ok: false, error: 'The storage refused these credentials. Check the key and that it can read and write this bucket.' };
      return { ok: false, error: `The storage answered ${response.status}.` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getStorageInfo(): Promise<StorageInfo> {
    const target = await this.open();
    const where = target.kind === 'azure' ? `${target.endpoint.host}/${target.container}` : `${target.endpoint.host}/${target.bucket}`;
    return { location: `${where}/${this.prefix}`, locationType: 'url' };
  }

  async getRemoteManifest(): Promise<SyncManifest | null> {
    const data = await this.getFile(MANIFEST_KEY);
    return data ? (JSON.parse(data.toString('utf8')) as SyncManifest) : null;
  }

  async putRemoteManifest(manifest: SyncManifest): Promise<void> {
    await this.putFile(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest)));
  }

  async getFile(remotePath: string): Promise<Buffer | null> {
    const response = await this.request('GET', remotePath);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Reading ${remotePath} failed: the storage answered ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  }

  async putFile(remotePath: string, data: Buffer): Promise<void> {
    const response = await this.request('PUT', remotePath, data);
    if (!response.ok) throw new Error(`Writing ${remotePath} failed: the storage answered ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
  }

  async deleteFile(remotePath: string): Promise<void> {
    const response = await this.request('DELETE', remotePath);
    if (!response.ok && response.status !== 404) throw new Error(`Deleting ${remotePath} failed: the storage answered ${response.status}.`);
  }
}

export default CloudStorageProvider;
