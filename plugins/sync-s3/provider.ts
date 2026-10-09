/**
 * S3-compatible object storage sync provider.
 *
 * Works with AWS S3, Cloudflare R2, MinIO, Backblaze B2, and any
 * S3-compatible service. Uses AWS Signature V4 for authentication
 * with zero external dependencies — only Node.js built-ins.
 */

import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import type { StorageInfo, SyncManifest, SyncProvider } from '@recursivecomputer/plugin-sdk';

const MANIFEST_KEY = '.sync-manifest.json';

interface S3Config {
  bucket: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

// ─── AWS Signature V4 ────────────────────────────────────────────

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function signRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer | string,
  config: S3Config,
): Record<string, string> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const payloadHash = sha256(body || '');
  const signedHeaders = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };

  const sortedHeaderKeys = Object.keys(signedHeaders).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${signedHeaders[Object.keys(signedHeaders).find(h => h.toLowerCase() === k)!].trim()}`).join('\n') + '\n';
  const signedHeaderStr = sortedHeaderKeys.join(';');

  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaderStr, payloadHash].join('\n');
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = getSignatureKey(config.secretAccessKey, dateStamp, config.region, 's3');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...signedHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderStr}, Signature=${signature}`,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────

function parseEndpoint(config: S3Config): { hostname: string; port: number; protocol: 'https:' | 'http:'; pathStyle: boolean } {
  if (config.endpoint) {
    const url = new URL(config.endpoint);
    return {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol as 'https:' | 'http:',
      pathStyle: true, // custom endpoints always use path-style
    };
  }
  return {
    hostname: `${config.bucket}.s3.${config.region}.amazonaws.com`,
    port: 443,
    protocol: 'https:',
    pathStyle: false, // AWS uses virtual-hosted style
  };
}

function s3Request(
  method: string,
  key: string,
  config: S3Config,
  body: Buffer = Buffer.alloc(0),
): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const ep = parseEndpoint(config);
    const bucketPath = ep.pathStyle ? `/${config.bucket}` : '';
    const objectPath = `${bucketPath}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

    const baseHeaders: Record<string, string> = {
      Host: ep.hostname,
      'Content-Length': String(body.length),
    };
    if (method === 'PUT') baseHeaders['Content-Type'] = 'application/octet-stream';

    const signed = signRequest(method, objectPath, baseHeaders, body, config);

    const mod = ep.protocol === 'https:' ? https : http;
    const req = mod.request({
      method,
      hostname: ep.hostname,
      port: ep.port,
      path: objectPath,
      headers: signed,
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') respHeaders[k] = v;
        }
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: respHeaders });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('S3 request timed out')); });
    if (body.length > 0) req.write(body);
    req.end();
  });
}

// ─── Provider ────────────────────────────────────────────────────

export class S3SyncProvider implements SyncProvider {
  readonly id = 's3';
  readonly name = 'S3 / Object Storage';
  readonly description = 'Sync to S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2).';

  private config: S3Config | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const bucket = config.bucket as string;
    const accessKeyId = config.access_key_id as string;
    const secretAccessKey = config.secret_access_key as string;

    if (!bucket) throw new Error('bucket is required');
    if (!accessKeyId) throw new Error('access_key_id is required');
    if (!secretAccessKey) throw new Error('secret_access_key is required');

    let prefix = (config.prefix as string) || 'recursive-sync/';
    if (!prefix.endsWith('/')) prefix += '/';

    this.config = {
      bucket,
      region: (config.region as string) || 'us-east-1',
      endpoint: (config.endpoint as string) || null,
      accessKeyId,
      secretAccessKey,
      prefix,
    };
  }

  async dispose(): Promise<void> {
    this.config = null;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.config) return { ok: false, error: 'Provider not initialized' };
    try {
      const res = await s3Request('HEAD', this.config.prefix + '__probe__', this.config);
      // 404 is fine — it means the bucket exists and we have access but the probe key doesn't exist
      if (res.status === 404 || res.status === 200) return { ok: true };
      if (res.status === 403) return { ok: false, error: 'Access denied — check credentials and bucket policy.' };
      return { ok: false, error: `Unexpected status ${res.status}: ${res.body.toString('utf8').slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getStorageInfo(): Promise<StorageInfo> {
    if (!this.config) throw new Error('Provider not initialized');
    const ep = this.config.endpoint;
    const location = ep
      ? `${ep}/${this.config.bucket}/${this.config.prefix}`
      : `s3://${this.config.bucket}/${this.config.prefix}`;
    return { location, locationType: 'url' };
  }

  private key(relativePath: string): string {
    return this.config!.prefix + relativePath;
  }

  async getRemoteManifest(): Promise<SyncManifest | null> {
    if (!this.config) return null;
    try {
      const res = await s3Request('GET', this.key(MANIFEST_KEY), this.config);
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      return null;
    }
  }

  async putRemoteManifest(manifest: SyncManifest): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    await s3Request('PUT', this.key(MANIFEST_KEY), this.config, Buffer.from(JSON.stringify(manifest, null, 2)));
  }

  async getFile(remotePath: string): Promise<Buffer | null> {
    if (!this.config) return null;
    try {
      const res = await s3Request('GET', this.key('data/' + remotePath), this.config);
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      return res.body;
    } catch {
      return null;
    }
  }

  async putFile(remotePath: string, data: Buffer): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    const res = await s3Request('PUT', this.key('data/' + remotePath), this.config, data);
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`S3 PUT failed (${res.status}): ${res.body.toString('utf8').slice(0, 200)}`);
    }
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    await s3Request('DELETE', this.key('data/' + remotePath), this.config);
  }

  async acquireLock(deviceId: string, ttlMs: number): Promise<boolean> {
    if (!this.config) return false;
    const lockKey = this.key('.sync-lock.json');
    try {
      const res = await s3Request('GET', lockKey, this.config);
      if (res.status === 200) {
        const lock = JSON.parse(res.body.toString('utf8'));
        const lockAge = Date.now() - new Date(lock.acquiredAt).getTime();
        if (lock.deviceId !== deviceId && lockAge < ttlMs) return false;
      }
    } catch {}
    const lockData = JSON.stringify({ deviceId, acquiredAt: new Date().toISOString(), ttlMs });
    await s3Request('PUT', lockKey, this.config, Buffer.from(lockData));
    return true;
  }

  async releaseLock(deviceId: string): Promise<void> {
    if (!this.config) return;
    const lockKey = this.key('.sync-lock.json');
    try {
      const res = await s3Request('GET', lockKey, this.config);
      if (res.status === 200) {
        const lock = JSON.parse(res.body.toString('utf8'));
        if (lock.deviceId === deviceId) {
          await s3Request('DELETE', lockKey, this.config);
        }
      }
    } catch {}
  }
}
