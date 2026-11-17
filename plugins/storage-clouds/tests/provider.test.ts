import crypto from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../plugin.json';
import { CloudStorageProvider, azureSignature, cloudflareR2Credentials } from '../provider.js';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

const objects = new Map<string, Buffer>();
const seen: Seen[] = [];
const buckets: string[] = [];
let server: http.Server;
let base = '';
const TOKEN = 'cf-token-value-123';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url, headers: req.headers });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.startsWith('/cf/')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(403, { success: false, errors: [{ code: 1000, message: 'Invalid token' }] });
        if (url === '/cf/user/tokens/verify') return json(200, { success: true, result: { id: 'tok_abc', status: 'active' } });
        if (url === '/cf/accounts') return json(200, { success: true, result: [{ id: 'acct123', name: 'Jack' }] });
        if (url === '/cf/accounts/acct123/r2/buckets' && req.method === 'POST') {
          const name = JSON.parse(Buffer.concat(chunks).toString()).name as string;
          if (buckets.includes(name)) return json(409, { success: false, errors: [{ code: 10004, message: 'The bucket you tried to create already exists.' }] });
          buckets.push(name);
          return json(200, { success: true, result: { name } });
        }
        return json(404, { success: false, errors: [{ code: 7003, message: 'No route' }] });
      }
      const key = decodeURIComponent(url.split('?')[0]!);
      if (req.method === 'PUT') {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(201);
        return res.end();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      const found = objects.get(key);
      res.writeHead(found ? 200 : 404);
      res.end(req.method === 'HEAD' ? undefined : found);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

describe('Cloud Storage', () => {
  it('sets Cloudflare R2 up from one token: finds the account, makes the bucket once, and derives its S3 keys', async () => {
    const config = { preset: 'r2', api_token: TOKEN, cloudflare_api: `${base}/cf` };
    const first = await cloudflareR2Credentials(config);
    expect(first).toMatchObject({ accountId: 'acct123', bucket: 'recursive-backups', accessKeyId: 'tok_abc', endpoint: 'https://acct123.r2.cloudflarestorage.com' });
    expect(first.secretAccessKey).toBe(crypto.createHash('sha256').update(TOKEN).digest('hex'));
    await expect(cloudflareR2Credentials(config)).resolves.toMatchObject({ bucket: 'recursive-backups' });
    expect(buckets).toEqual(['recursive-backups']);
    await expect(cloudflareR2Credentials({ ...config, api_token: 'wrong' })).rejects.toThrow(/cannot see an account|did not accept/);
  });

  it('stores, reads and deletes through R2 with requests signed by the derived key', async () => {
    const provider = new CloudStorageProvider();
    await provider.initialize({ preset: 'r2', api_token: TOKEN, cloudflare_api: `${base}/cf`, endpoint: base });
    expect(await provider.testConnection()).toEqual({ ok: true });
    await provider.putFile('o_1/config.json', Buffer.from('{"a":1}'));
    expect(objects.has('/recursive-backups/recursive-backups/o_1/config.json')).toBe(true);
    expect((await provider.getFile('o_1/config.json'))?.toString()).toBe('{"a":1}');
    await provider.deleteFile('o_1/config.json');
    expect(await provider.getFile('o_1/config.json')).toBeNull();
    const put = seen.find((request) => request.method === 'PUT' && request.url.includes('config.json'))!;
    expect(String(put.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=tok_abc\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  it('reports a failing read instead of treating it as a missing file', async () => {
    const provider = new CloudStorageProvider();
    await provider.initialize({ preset: 's3', endpoint: `${base}/cf`, bucket: 'b', access_key_id: 'k', secret_access_key: 's' });
    await expect(provider.getFile('x')).rejects.toThrow(/answered 403/);
  });

  it('builds the right endpoint for each cloud', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ preset: 'aws', bucket: 'mine', region: 'eu-west-1' }, 's3.eu-west-1.amazonaws.com/mine'],
      [{ preset: 'gcs', bucket: 'mine' }, 'storage.googleapis.com/mine'],
      [{ preset: 'b2', bucket: 'mine', region: 'us-west-004' }, 's3.us-west-004.backblazeb2.com/mine'],
      [{ preset: 'wasabi', bucket: 'mine' }, 's3.us-east-1.wasabisys.com/mine'],
      [{ preset: 'do', bucket: 'mine', region: 'nyc3' }, 'nyc3.digitaloceanspaces.com/mine'],
      [{ preset: 'hetzner', bucket: 'mine', region: 'fsn1' }, 'fsn1.your-objectstorage.com/mine'],
      [{ preset: 'azure', account_name: 'acct', account_key: Buffer.from('k').toString('base64') }, 'acct.blob.core.windows.net/recursive-backups'],
    ];
    for (const [config, where] of cases) {
      const provider = new CloudStorageProvider();
      await provider.initialize({ access_key_id: 'k', secret_access_key: 's', ...config });
      expect((await provider.getStorageInfo()).location).toBe(`${where}/recursive-backups/`);
    }
    await expect(new CloudStorageProvider().initialize({ preset: 'b2', bucket: 'x', access_key_id: 'k', secret_access_key: 's' })).rejects.toThrow(/Backblaze region/);
  });

  it('signs Azure requests with the account key and makes the container on first write', async () => {
    const key = crypto.randomBytes(32);
    const provider = new CloudStorageProvider();
    await provider.initialize({ preset: 'azure', account_name: 'acct', account_key: key.toString('base64'), endpoint: `${base}/azure` });
    objects.clear();
    seen.length = 0;
    await provider.putFile('o_1/blob', Buffer.from('hello'));
    expect((await provider.getFile('o_1/blob'))?.toString()).toBe('hello');
    const put = seen.find((request) => request.method === 'PUT' && request.url.endsWith('/o_1/blob'))!;
    expect(put.headers['x-ms-blob-type']).toBe('BlockBlob');
    const expected = azureSignature({
      account: 'acct',
      key,
      method: 'PUT',
      path: '/azure/recursive-backups/recursive-backups/o_1/blob',
      length: 5,
      contentType: 'application/octet-stream',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-date': String(put.headers['x-ms-date']), 'x-ms-version': String(put.headers['x-ms-version']) },
    });
    expect(put.headers.authorization).toBe(expected);
  });

  it('declares eight storage options with a logo, the fields they ask for, and prices', () => {
    const options = manifest.sync.provider.storage.options;
    expect(options.map((option) => option.label)).toEqual([
      'Cloudflare R2', 'Amazon S3', 'Google Cloud Storage', 'Azure Blob Storage', 'Backblaze B2', 'Wasabi', 'DigitalOcean Spaces', 'Hetzner Object Storage',
    ]);
    const properties = Object.keys(manifest.sync.provider.config_schema.properties);
    for (const option of options) {
      expect(option.logo).toMatch(/^logos\/.+\.svg$/);
      expect(option.pricing.per_gb_month).toBeGreaterThan(0);
      expect(option.setup_url).toMatch(/^https:\/\//);
      for (const field of [...option.fields, ...option.required]) expect(properties).toContain(field);
    }
    expect(options[0]!.fields).toEqual(['api_token', 'bucket', 'account_id']);
  });
});
