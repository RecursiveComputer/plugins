
import crypto from 'node:crypto';
import type {
  AuthProvider,
  AuthBeginContext,
  AuthBeginResult,
  ExternalIdentity,
  MemberDirectoryEntry,
  ResolvedRole,
  WorkspaceLink,
} from '@recursive/core-identity/auth';

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

interface GithubAuthConfig {
  auth_mode: 'app' | 'pat';
  client_id?: string;
  client_secret?: string;
  app_id?: string;
  installation_id?: string;
  private_key?: string;
  api_token?: string;
  repo?: string;
  role_map?: Record<string, string>;
  sync_interval_minutes?: number;
  __fetch?: FetchLike;
}

const GH_API = 'https://api.github.com';
const GH_WEB = 'https://github.com';
const SCOPES = 'read:user read:org user:email';
const API_VERSION = '2022-11-28';

const DEFAULT_ROLE_MAP: Record<string, string> = {
  admin: 'admin',
  maintain: 'member',
  write: 'member',
  push: 'member',
  triage: 'guest',
  read: 'guest',
  pull: 'guest',
  none: 'deny',
};

type Role = 'owner' | 'admin' | 'member' | 'guest';

function isRole(v: string): v is Role {
  return v === 'owner' || v === 'admin' || v === 'member' || v === 'guest';
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class GithubAuthProvider implements AuthProvider {
  readonly id = 'github';
  readonly name = 'GitHub';

  private config: GithubAuthConfig = { auth_mode: 'pat' };
  private roleMap: Record<string, string> = { ...DEFAULT_ROLE_MAP };
  private fetchImpl: FetchLike = ((input, init) => (globalThis.fetch as any)(input, init)) as FetchLike;
  private installationToken: { token: string; expiresAt: number } | null = null;

  setFetchForTesting(fn: FetchLike): void {
    this.fetchImpl = fn;
  }

  async initialize(config: Record<string, unknown>): Promise<void> {
    const c = config as Partial<GithubAuthConfig>;
    this.config = {
      auth_mode: c.auth_mode === 'app' ? 'app' : 'pat',
      client_id: str(c.client_id),
      client_secret: str(c.client_secret),
      app_id: str(c.app_id),
      installation_id: str(c.installation_id),
      private_key: str(c.private_key),
      api_token: str(c.api_token),
      repo: str(c.repo),
      role_map: c.role_map && typeof c.role_map === 'object' ? c.role_map : undefined,
      sync_interval_minutes: typeof c.sync_interval_minutes === 'number' ? c.sync_interval_minutes : 30,
    };
    this.roleMap = { ...DEFAULT_ROLE_MAP, ...(this.config.role_map ?? {}) };
    if (typeof c.__fetch === 'function') this.fetchImpl = c.__fetch;
  }

  async dispose(): Promise<void> {
    this.installationToken = null;
  }


  async beginAuth(ctx: AuthBeginContext): Promise<AuthBeginResult> {
    if (!this.config.client_id) throw new Error('github-auth: client_id not configured');

    if (ctx.mode === 'web') {
      const params = new URLSearchParams({
        client_id: this.config.client_id,
        scope: SCOPES,
        ...(ctx.redirect_uri ? { redirect_uri: ctx.redirect_uri } : {}),
        ...(ctx.state ? { state: ctx.state } : {}),
      });
      return { url: `${GH_WEB}/login/oauth/authorize?${params.toString()}` };
    }

    const res = await this.fetchImpl(`${GH_WEB}/login/device/code`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.client_id, scope: SCOPES }),
    });
    const data = await res.json();
    if (!res.ok || !data.device_code) {
      throw new Error(`github-auth: device code request failed (${res.status}) ${data.error ?? ''}`);
    }
    return {
      url: data.verification_uri,
      user_code: data.user_code,
      device_code: data.device_code,
      poll: {
        interval_seconds: typeof data.interval === 'number' ? data.interval : 5,
        expires_in_seconds: typeof data.expires_in === 'number' ? data.expires_in : 900,
      },
    };
  }

  async completeAuth(payload: Record<string, unknown>): Promise<ExternalIdentity> {
    const token = await this.exchangeForToken(payload);
    const user = await this.ghJson(`${GH_API}/user`, token);
    let email = str(user.email);
    if (!email) email = await this.primaryEmail(token);
    return {
      provider: 'github',
      subject: String(user.id),
      login: str(user.login),
      name: str(user.name),
      email,
      avatar: str(user.avatar_url),
      access_token: token,
    };
  }

  private async exchangeForToken(payload: Record<string, unknown>): Promise<string> {
    const clientId = this.config.client_id;
    if (!clientId) throw new Error('github-auth: client_id not configured');

    const body: Record<string, string> = { client_id: clientId };
    if (typeof payload.device_code === 'string') {
      body.device_code = payload.device_code;
      body.grant_type = 'urn:ietf:params:oauth:grant-type:device_code';
    } else if (typeof payload.code === 'string') {
      body.code = payload.code;
      if (this.config.client_secret) body.client_secret = this.config.client_secret;
      if (typeof payload.redirect_uri === 'string') body.redirect_uri = payload.redirect_uri;
    } else {
      throw new Error('github-auth: completeAuth needs a device_code or code');
    }

    const res = await this.fetchImpl(`${GH_WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      throw new Error(`github-auth: ${data.error}`);
    }
    if (!data.access_token) throw new Error('github-auth: no access_token in token response');
    return data.access_token as string;
  }

  private async primaryEmail(token: string): Promise<string | undefined> {
    try {
      const emails = await this.ghJson(`${GH_API}/user/emails`, token);
      if (Array.isArray(emails)) {
        const primary = emails.find((e: any) => e.primary && e.verified) ?? emails[0];
        return primary ? str(primary.email) : undefined;
      }
    } catch {
    }
    return undefined;
  }


  async resolveRole(identity: ExternalIdentity, ws: WorkspaceLink): Promise<ResolvedRole> {
    const repo = this.repoFor(ws);
    if (!repo) return { deny: true, reason: 'no repo linked' };
    const login = identity.login;
    if (!login) return { deny: true, reason: 'identity has no github login' };

    const token = await this.apiToken();
    const res = await this.fetchImpl(
      `${GH_API}/repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`,
      { headers: this.apiHeaders(token) },
    );
    if (res.status === 404) return { deny: true, reason: `${login} is not a collaborator on ${repo.owner}/${repo.name}` };
    if (!res.ok) throw new Error(`github-auth: permission check failed (${res.status})`);

    const data = await res.json();
    const key = permissionKey({ role_name: data.role_name, permission: data.permission });
    return this.mapKeyToRole(key, `${login} has ${key} on ${repo.owner}/${repo.name}`);
  }

  async syncMembers(ws: WorkspaceLink): Promise<MemberDirectoryEntry[]> {
    const repo = this.repoFor(ws);
    if (!repo) return [];
    const token = await this.apiToken();
    const entries: MemberDirectoryEntry[] = [];

    for (let page = 1; page <= 20; page++) {
      const res = await this.fetchImpl(
        `${GH_API}/repos/${repo.owner}/${repo.name}/collaborators?per_page=100&page=${page}`,
        { headers: this.apiHeaders(token) },
      );
      if (!res.ok) break;
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) break;
      for (const c of list) {
        const key = permissionKey({ role_name: c.role_name, permissions: c.permissions });
        const resolved = this.mapKeyToRole(key, `collaborator ${c.login}`);
        if ('deny' in resolved) continue; // only pre-populate people with a mappable role
        entries.push({
          identity: {
            provider: 'github',
            subject: String(c.id),
            login: str(c.login),
            avatar: str(c.avatar_url),
          },
          role: resolved.role,
          reason: resolved.reason,
        });
      }
      if (list.length < 100) break;
    }
    return entries;
  }

  async refreshIdentity(
    member: { identities: Array<{ provider: string; subject: string; login?: string; avatar?: string }> },
    ws: WorkspaceLink,
  ): Promise<ExternalIdentity | 'revoked'> {
    const gh = member.identities.find((i) => i.provider === 'provider:github');
    if (!gh || !gh.login) return 'revoked';
    const repo = this.repoFor(ws);
    if (!repo) return 'revoked';

    const token = await this.apiToken();
    const res = await this.fetchImpl(
      `${GH_API}/repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(gh.login)}/permission`,
      { headers: this.apiHeaders(token) },
    );
    if (res.status === 404) return 'revoked';
    if (!res.ok) throw new Error(`github-auth: permission refresh failed (${res.status})`);
    const data = await res.json();
    const key = permissionKey({ role_name: data.role_name, permission: data.permission });
    if (this.roleMap[key] === 'deny' || key === 'none') return 'revoked';
    return { provider: 'github', subject: gh.subject, login: gh.login, avatar: gh.avatar };
  }

  async revoke(): Promise<void> {
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const token = await this.apiToken();
      const res = await this.fetchImpl(`${GH_API}/rate_limit`, { headers: this.apiHeaders(token) });
      return res.ok ? { ok: true } : { ok: false, error: `GitHub API returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }


  private mapKeyToRole(key: string, reason: string): { role: Role; reason: string } | { deny: true; reason: string } {
    const mapped = this.roleMap[key] ?? 'deny';
    if (mapped === 'deny' || !isRole(mapped)) return { deny: true, reason };
    return { role: mapped, reason };
  }

  private repoFor(ws: WorkspaceLink): { owner: string; name: string } | null {
    const raw = (typeof ws.repo === 'string' && ws.repo) || this.config.repo || '';
    const [owner, name] = raw.split('/');
    return owner && name ? { owner, name } : null;
  }

  private apiHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'recursive-github-auth',
      'X-GitHub-Api-Version': API_VERSION,
    };
  }

  private async ghJson(url: string, token: string): Promise<any> {
    const res = await this.fetchImpl(url, { headers: this.apiHeaders(token) });
    if (!res.ok) throw new Error(`github-auth: GET ${url} → ${res.status}`);
    return res.json();
  }

  private async apiToken(): Promise<string> {
    if (this.config.auth_mode === 'pat') {
      if (!this.config.api_token) throw new Error('github-auth: api_token not configured');
      return this.config.api_token;
    }
    return this.installationAccessToken();
  }

  private async installationAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.installationToken && this.installationToken.expiresAt - 60 > now) {
      return this.installationToken.token;
    }
    const { app_id, installation_id, private_key } = this.config;
    if (!app_id || !installation_id || !private_key) {
      throw new Error('github-auth: app_id, installation_id, private_key required for auth_mode=app');
    }
    const jwt = signAppJwt(app_id, private_key, now);
    const res = await this.fetchImpl(`${GH_API}/app/installations/${installation_id}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'User-Agent': 'recursive-github-auth',
        'X-GitHub-Api-Version': API_VERSION,
      },
    });
    const data = await res.json();
    if (!res.ok || !data.token) throw new Error(`github-auth: installation token failed (${res.status})`);
    const expiresAt = data.expires_at ? Math.floor(new Date(data.expires_at).getTime() / 1000) : now + 3000;
    this.installationToken = { token: data.token, expiresAt };
    return data.token;
  }
}

function permissionKey(input: {
  role_name?: string;
  permission?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}): string {
  const p = input.permissions;
  if (p) {
    if (p.admin) return 'admin';
    if (p.maintain) return 'maintain';
    if (p.push) return 'write';
    if (p.triage) return 'triage';
    if (p.pull) return 'read';
    return 'none';
  }
  if (input.role_name) {
    const r = input.role_name.toLowerCase();
    return r === 'push' ? 'write' : r;
  }
  switch (input.permission) {
    case 'admin':
      return 'admin';
    case 'write':
      return 'write';
    case 'read':
      return 'read';
    default:
      return 'none';
  }
}

function signAppJwt(appId: string, privateKey: string, now: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export default GithubAuthProvider;
