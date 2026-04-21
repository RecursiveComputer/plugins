/**
 * WebDAV sync provider.
 *
 * Works with Nextcloud, ownCloud, Synology, and any WebDAV-compatible
 * server. Uses standard HTTP methods (GET, PUT, DELETE, MKCOL, PROPFIND)
 * with zero external dependencies.
 */

import https from 'node:https';
import http from 'node:http';
import type { SyncProvider, StorageInfo } from '@recursive/core-sync/provider';
import type { SyncManifest } from '@recursive/core-types/sync';

const MANIFEST_FILENAME = '.sync-manifest.json';

interface WebDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  basePath: string;
}

// ─── HTTP helpers ────────────────────────────────────────────────

function davRequest(
  method: string,
  urlPath: string,
  config: WebDAVConfig,
  body: Buffer = Buffer.alloc(0),
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, config.serverUrl);
    const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        ...extraHeaders,
      },
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WebDAV request timed out')); });
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function joinPath(base: string, ...parts: string[]): string {
  const joined = [base.replace(/\/+$/, ''), ...parts.map(p => p.replace(/^\/+|\/+$/g, ''))].join('/');
  return joined;
}

// ─── Provider ────────────────────────────────────────────────────

export class WebDAVSyncProvider implements SyncProvider {
  readonly id = 'webdav';
  readonly name = 'WebDAV Server';
  readonly description = 'Sync to a WebDAV endpoint (Nextcloud, ownCloud, Synology).';

  private config: WebDAVConfig | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const serverUrl = config.server_url as string;
    const username = config.username as string;
    const password = config.password as string;

    if (!serverUrl) throw new Error('server_url is required');
    if (!username) throw new Error('username is required');
    if (!password) throw new Error('password is required');

    let basePath = (config.base_path as string) || '/Recursive/';
    if (!basePath.startsWith('/')) basePath = '/' + basePath;
    if (!basePath.endsWith('/')) basePath += '/';

    this.config = { serverUrl: serverUrl.replace(/\/+$/, ''), username, password, basePath };

    // Ensure base directory exists
    await this.mkcolRecursive(this.config.basePath);
    await this.mkcolRecursive(this.config.basePath + 'data/');
  }

  async dispose(): Promise<void> {
    this.config = null;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.config) return { ok: false, error: 'Provider not initialized' };
    try {
      const res = await davRequest('PROPFIND', this.config.basePath, this.config, Buffer.alloc(0), { Depth: '0' });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      if (res.status === 207) return { ok: true }; // Multi-Status is success for PROPFIND
      if (res.status === 401) return { ok: false, error: 'Authentication failed — check username and password.' };
      if (res.status === 404) return { ok: false, error: `Path not found: ${this.config.basePath}` };
      return { ok: false, error: `Unexpected status ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getStorageInfo(): Promise<StorageInfo> {
    if (!this.config) throw new Error('Provider not initialized');
    return {
      location: `${this.config.serverUrl}${this.config.basePath}`,
      locationType: 'url',
    };
  }

  private remotePath(relativePath: string): string {
    return joinPath(this.config!.basePath, relativePath);
  }

  private async mkcolRecursive(dirPath: string): Promise<void> {
    if (!this.config) return;
    const parts = dirPath.split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current += part + '/';
      try {
        await davRequest('MKCOL', current, this.config);
      } catch {}
    }
  }

  async getRemoteManifest(): Promise<SyncManifest | null> {
    if (!this.config) return null;
    try {
      const res = await davRequest('GET', this.remotePath(MANIFEST_FILENAME), this.config);
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      return JSON.parse(res.body.toString('utf8'));
    } catch {
      return null;
    }
  }

  async putRemoteManifest(manifest: SyncManifest): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    const data = Buffer.from(JSON.stringify(manifest, null, 2));
    await davRequest('PUT', this.remotePath(MANIFEST_FILENAME), this.config, data);
  }

  async getFile(remotePath: string): Promise<Buffer | null> {
    if (!this.config) return null;
    try {
      const res = await davRequest('GET', this.remotePath('data/' + remotePath), this.config);
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      return res.body;
    } catch {
      return null;
    }
  }

  async putFile(remotePath: string, data: Buffer): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    // Ensure parent directory exists
    const parts = remotePath.split('/');
    if (parts.length > 1) {
      const dirPath = parts.slice(0, -1).join('/');
      await this.mkcolRecursive(joinPath(this.config.basePath, 'data', dirPath));
    }
    await davRequest('PUT', this.remotePath('data/' + remotePath), this.config, data);
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    try {
      await davRequest('DELETE', this.remotePath('data/' + remotePath), this.config);
    } catch {}
  }

  async acquireLock(deviceId: string, ttlMs: number): Promise<boolean> {
    if (!this.config) return false;
    const lockPath = this.remotePath('.sync-lock.json');
    try {
      const res = await davRequest('GET', lockPath, this.config);
      if (res.status === 200) {
        const lock = JSON.parse(res.body.toString('utf8'));
        const lockAge = Date.now() - new Date(lock.acquiredAt).getTime();
        if (lock.deviceId !== deviceId && lockAge < ttlMs) return false;
      }
    } catch {}
    const lockData = JSON.stringify({ deviceId, acquiredAt: new Date().toISOString(), ttlMs });
    await davRequest('PUT', lockPath, this.config, Buffer.from(lockData));
    return true;
  }

  async releaseLock(deviceId: string): Promise<void> {
    if (!this.config) return;
    const lockPath = this.remotePath('.sync-lock.json');
    try {
      const res = await davRequest('GET', lockPath, this.config);
      if (res.status === 200) {
        const lock = JSON.parse(res.body.toString('utf8'));
        if (lock.deviceId === deviceId) {
          await davRequest('DELETE', lockPath, this.config);
        }
      }
    } catch {}
  }
}
