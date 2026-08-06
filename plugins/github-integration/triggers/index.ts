import crypto from 'node:crypto';
import type {
  TriggerSourceModule,
  TriggerVerifyResult,
  TriggerConnection,
  NormalizedTriggerEvent,
} from '@recursive/core-types/automation';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function signBody(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max - 3) + '…' : text;
}

export function verify(
  rawBody: string,
  headers: Record<string, string | undefined>,
  connection: TriggerConnection,
): TriggerVerifyResult {
  const settingsSecret = connection.settings?.webhook_secret;
  const secret = (typeof settingsSecret === 'string' && settingsSecret) ? settingsSecret : connection.secret;
  const signature = headers['x-hub-signature-256'];

  if (secret) {
    if (!signature) {
      return { ok: false, reason: 'Missing X-Hub-Signature-256 header' };
    }
    const expected = signBody(secret, rawBody);
    if (!safeEqual(expected, signature)) {
      return { ok: false, reason: 'Bad GitHub signature' };
    }
  }

  if (headers['x-github-event'] === 'ping') {
    return {
      handshake: true,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true, message: 'pong' }),
    };
  }

  return { ok: true };
}

export function normalize(
  payload: unknown,
  headers: Record<string, string | undefined>,
  _connection: TriggerConnection,
): NormalizedTriggerEvent | null {
  const eventType = str(headers['x-github-event']);
  if (!eventType || eventType === 'ping') return null;

  const body = asRecord(payload);
  const repository = asRecord(body.repository);
  const repo = str(repository.full_name);
  const sender = str(asRecord(body.sender).login);
  const action = str(body.action);

  const deliveryId = str(headers['x-github-delivery']);

  let title: string | undefined;
  let summary: string | undefined;
  let url: string | undefined;
  let branch: string | undefined;

  switch (eventType) {
    case 'issues': {
      const issue = asRecord(body.issue);
      const num = typeof issue.number === 'number' ? `#${issue.number}` : '';
      title = `Issue ${num} ${action ?? 'updated'}: ${str(issue.title) ?? ''}`.trim();
      summary = str(issue.body);
      url = str(issue.html_url);
      break;
    }
    case 'issue_comment': {
      const issue = asRecord(body.issue);
      const comment = asRecord(body.comment);
      const num = typeof issue.number === 'number' ? `#${issue.number}` : '';
      title = `Comment on ${num} ${str(issue.title) ?? ''}`.trim();
      summary = str(comment.body);
      url = str(comment.html_url) ?? str(issue.html_url);
      break;
    }
    case 'pull_request': {
      const pr = asRecord(body.pull_request);
      const num = typeof pr.number === 'number' ? `#${pr.number}` : '';
      title = `PR ${num} ${action ?? 'updated'}: ${str(pr.title) ?? ''}`.trim();
      summary = str(pr.body);
      url = str(pr.html_url);
      break;
    }
    case 'push': {
      const ref = str(body.ref); // refs/heads/<branch> or refs/tags/<tag>
      branch = ref?.replace(/^refs\/(heads|tags)\//, '');
      const head = asRecord(body.head_commit);
      const message = str(head.message);
      const commits = Array.isArray(body.commits) ? body.commits.length : 0;
      title = message
        ? `Push to ${branch ?? 'branch'}: ${truncate(message.split('\n')[0])}`
        : `Push to ${branch ?? 'branch'} (${commits} commit${commits === 1 ? '' : 's'})`;
      summary = message;
      url = str(head.url) ?? str(body.compare);
      break;
    }
    case 'release': {
      const release = asRecord(body.release);
      const tag = str(release.tag_name);
      title = `Release ${tag ?? ''} ${action ?? 'updated'}: ${str(release.name) ?? tag ?? ''}`.trim();
      summary = str(release.body);
      url = str(release.html_url);
      break;
    }
    default:
      return null;
  }

  return {
    event_type: eventType,
    title: title ? truncate(title, 120) : `GitHub ${eventType}`,
    url,
    summary,
    delivery_id: deliveryId,
    project_hint: str(repository.name),
    match: {
      event_type: eventType,
      ...(repo ? { repo } : {}),
      ...(action ? { action } : {}),
      ...(sender ? { sender } : {}),
      ...(branch ? { branch } : {}),
    },
    raw: { repo, action, sender, branch, event_type: eventType, payload },
  };
}

const githubTriggerSource: TriggerSourceModule = { verify, normalize };
export default githubTriggerSource;
