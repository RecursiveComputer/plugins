/**
 * Filesystem sync provider.
 *
 * The simplest provider — copies files to/from a target directory.
 * Works with any folder, including cloud-synced folders like
 * Dropbox, iCloud Drive, Google Drive, or a NAS mount.
 *
 * This is the reference implementation for third-party developers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SyncProvider, StorageInfo } from '@recursive/core-sync/provider';
import type { SyncManifest } from '../../types/sync';

const MANIFEST_FILENAME = '.sync-manifest.json';

interface FsSyncConfig {
  target_path: string;
}

export class FsSyncProvider implements SyncProvider {
  readonly id = 'fs';
  readonly name = 'Filesystem / Folder';
  readonly description = 'Sync to a local or network-mounted folder.';

  private config: FsSyncConfig | null = null;

  async initialize(config: Record<string, unknown>): Promise<void> {
    const targetPath = config.target_path as string;
    if (!targetPath) {
      throw new Error('target_path is required for Filesystem sync provider');
    }

    // Expand ~ to home directory
    const resolved = targetPath.startsWith('~')
      ? path.join(require('os').homedir(), targetPath.slice(1))
      : targetPath;

    this.config = { target_path: path.resolve(resolved) };
    fs.mkdirSync(this.config.target_path, { recursive: true });
  }

  async dispose(): Promise<void> {
    this.config = null;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.config) {
      return { ok: false, error: 'Provider not initialized' };
    }
    try {
      fs.accessSync(this.config.target_path, fs.constants.R_OK | fs.constants.W_OK);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Cannot access ${this.config.target_path}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getStorageInfo(): Promise<StorageInfo> {
    if (!this.config) throw new Error('Provider not initialized');
    let fileCount = 0;
    let totalBytes = 0;
    let lastModified: Date | null = null;
    try {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          fileCount++;
          try {
            const stat = fs.statSync(full);
            totalBytes += stat.size;
            if (!lastModified || stat.mtime > lastModified) lastModified = stat.mtime;
          } catch {}
        }
      };
      if (fs.existsSync(this.config.target_path)) walk(this.config.target_path);
    } catch {}
    return {
      location: this.config.target_path,
      locationType: 'path',
      fileCount,
      totalBytes,
      lastModified: lastModified?.toISOString() ?? undefined,
    };
  }

  async getRemoteManifest(): Promise<SyncManifest | null> {
    if (!this.config) return null;
    const manifestPath = path.join(this.config.target_path, MANIFEST_FILENAME);
    try {
      const content = fs.readFileSync(manifestPath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async putRemoteManifest(manifest: SyncManifest): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    const manifestPath = path.join(this.config.target_path, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  async getFile(remotePath: string): Promise<Buffer | null> {
    if (!this.config) return null;
    const fullPath = path.join(this.config.target_path, 'data', remotePath);
    try {
      return fs.readFileSync(fullPath);
    } catch {
      return null;
    }
  }

  async putFile(remotePath: string, data: Buffer): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    const fullPath = path.join(this.config.target_path, 'data', remotePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
  }

  async deleteFile(remotePath: string): Promise<void> {
    if (!this.config) throw new Error('Provider not initialized');
    const fullPath = path.join(this.config.target_path, 'data', remotePath);
    try { fs.unlinkSync(fullPath); } catch {}
  }

  async getFiles(remotePaths: string[]): Promise<Map<string, Buffer | null>> {
    const results = new Map<string, Buffer | null>();
    for (const p of remotePaths) {
      results.set(p, await this.getFile(p));
    }
    return results;
  }

  async putFiles(files: Map<string, Buffer>): Promise<void> {
    for (const [p, data] of files) {
      await this.putFile(p, data);
    }
  }
}
