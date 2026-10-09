import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verify, normalize } from './index.ts';
import type { NormalizedTriggerEvent, TriggerConnection } from '@recursive/plugin-sdk';

const SECRET = 'gh-webhook-secret-for-smoke-test';
const connection: TriggerConnection = {
  id: 'default',
  plugin_id: 'github-integration',
  settings: { webhook_secret: SECRET },
};

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

const one = (v: NormalizedTriggerEvent | NormalizedTriggerEvent[] | null): NormalizedTriggerEvent => {
  assert.ok(v && !Array.isArray(v), 'normalize returns a single event');
  return v;
};


const issuesPayload = {
  action: 'opened',
  issue: {
    number: 42,
    title: 'Login button unresponsive on Safari',
    body: 'Clicking Sign in does nothing on Safari 18.',
    html_url: 'https://github.com/acme/web/issues/42',
  },
  repository: { full_name: 'acme/web', name: 'web' },
  sender: { login: 'octocat' },
};

const pushPayload = {
  ref: 'refs/heads/main',
  compare: 'https://github.com/acme/web/compare/aaa...bbb',
  commits: [{ id: 'bbb' }],
  head_commit: {
    id: 'bbb',
    message: 'fix: debounce search input\n\nCloses #12',
    url: 'https://github.com/acme/web/commit/bbb',
  },
  repository: { full_name: 'acme/web', name: 'web' },
  sender: { login: 'octocat' },
};

const prPayload = {
  action: 'opened',
  pull_request: {
    number: 7,
    title: 'Add dark mode',
    body: 'Implements the theme toggle.',
    html_url: 'https://github.com/acme/web/pull/7',
  },
  repository: { full_name: 'acme/web', name: 'web' },
  sender: { login: 'hubot' },
};

const releasePayload = {
  action: 'published',
  release: {
    tag_name: 'v1.2.0',
    name: 'Summer release',
    body: 'Highlights: dark mode.',
    html_url: 'https://github.com/acme/web/releases/tag/v1.2.0',
  },
  repository: { full_name: 'acme/web', name: 'web' },
  sender: { login: 'octocat' },
};

const pingPayload = {
  zen: 'Keep it logically awesome.',
  hook_id: 12345,
  repository: { full_name: 'acme/web', name: 'web' },
};


{
  const body = JSON.stringify(issuesPayload);
  const v = verify(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'issues' }, connection);
  assert.deepEqual(v, { ok: true }, 'verify accepts a correct X-Hub-Signature-256');
}

{
  const body = JSON.stringify(issuesPayload);
  const v = verify(body, { 'x-hub-signature-256': sign(body, 'wrong-secret'), 'x-github-event': 'issues' }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a signature made with the wrong secret');
}

{
  const body = JSON.stringify(issuesPayload);
  const tampered = JSON.stringify({ ...issuesPayload, action: 'closed' });
  const v = verify(tampered, { 'x-hub-signature-256': sign(body), 'x-github-event': 'issues' }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects when the body was tampered with');
}

{
  const v = verify(JSON.stringify(issuesPayload), { 'x-github-event': 'issues' }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a missing X-Hub-Signature-256 header');
}

{
  const body = JSON.stringify(pingPayload);
  const v = verify(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'ping' }, connection);
  assert.ok('handshake' in v && v.handshake, 'signed ping is answered as a handshake');
  assert.ok(v.body.includes('pong'), 'handshake body answers pong');
}

{
  const body = JSON.stringify(pingPayload);
  const v = verify(body, { 'x-hub-signature-256': sign(body, 'wrong'), 'x-github-event': 'ping' }, connection);
  assert.equal('ok' in v && (v as { ok: boolean }).ok, false, 'ping handshake does not bypass signature auth');
}


{
  const e = one(normalize(issuesPayload, {
    'x-github-event': 'issues',
    'x-github-delivery': 'deliv-uuid-1',
  }, connection));
  assert.equal(e.event_type, 'issues');
  assert.ok(e.title?.includes('#42'), 'title carries the issue number');
  assert.equal(e.url, 'https://github.com/acme/web/issues/42');
  assert.equal(e.summary, issuesPayload.issue.body);
  assert.equal(e.delivery_id, 'deliv-uuid-1', 'X-GitHub-Delivery becomes delivery_id');
  assert.equal(e.project_hint, 'web');
  assert.deepEqual(e.match, {
    event_type: 'issues',
    repo: 'acme/web',
    action: 'opened',
    sender: 'octocat',
  });
}

{
  const e = one(normalize(pushPayload, {
    'x-github-event': 'push',
    'x-github-delivery': 'deliv-uuid-2',
  }, connection));
  assert.equal(e.event_type, 'push');
  assert.equal(e.match?.branch, 'main', 'refs/heads/main → branch=main');
  assert.equal(e.match?.repo, 'acme/web');
  assert.equal(e.match?.action, undefined, 'push carries no action');
  assert.ok(e.title?.includes('fix: debounce search input'), 'title uses the head commit subject');
  assert.equal(e.url, 'https://github.com/acme/web/commit/bbb');
}

{
  const e = one(normalize(prPayload, { 'x-github-event': 'pull_request' }, connection));
  assert.equal(e.event_type, 'pull_request');
  assert.ok(e.title?.includes('#7'));
  assert.equal(e.match?.action, 'opened');
  assert.equal(e.match?.sender, 'hubot');
  assert.equal(e.url, 'https://github.com/acme/web/pull/7');
}

{
  const e = one(normalize(releasePayload, { 'x-github-event': 'release' }, connection));
  assert.equal(e.event_type, 'release');
  assert.ok(e.title?.includes('v1.2.0'));
  assert.equal(e.match?.action, 'published');
}

{
  assert.equal(normalize(pingPayload, { 'x-github-event': 'ping' }, connection), null, 'ping is never dispatched');
  assert.equal(normalize({ action: 'created' }, { 'x-github-event': 'star' }, connection), null, 'undeclared events are dropped');
  assert.equal(normalize(issuesPayload, {}, connection), null, 'no X-GitHub-Event header → nothing');
}

{
  const e = one(normalize({}, { 'x-github-event': 'issues' }, connection));
  assert.equal(e.event_type, 'issues');
  assert.ok(e.title, 'defensive title on empty payload');
  assert.equal(normalize(null, { 'x-github-event': 'push' }, connection)?.event_type, 'push');
  assert.equal(normalize('plain text', { 'x-github-event': 'release' }, connection)?.event_type, 'release');
}

console.log('github-integration trigger smoke test: all assertions passed');
