import assert from 'node:assert/strict';
import { verify, normalize } from './index.ts';
import type { TriggerConnection, NormalizedTriggerEvent } from '@recursive/core-types/automation';

const SECRET = 'super-secret-destination-token';
const connection: TriggerConnection = {
  id: 'default',
  plugin_id: 'cloudflare-integration',
  settings: { webhook_secret: SECRET },
};

const asArray = (v: NormalizedTriggerEvent | NormalizedTriggerEvent[] | null): NormalizedTriggerEvent[] =>
  !v ? [] : Array.isArray(v) ? v : [v];


const pagesAlert = {
  name: 'Pages deploy failed',
  text: 'Deployment failure for project my-pages-app on branch main.',
  alert_type: 'pages_event_alert',
  ts: 1751414400,
  policy_id: 'pol-123',
  account_id: 'acc-abc',
  data: { project_name: 'my-pages-app', environment: 'production' },
};

const healthAlert = {
  name: 'API health check',
  text: 'Health check api-origin changed from Healthy to Unhealthy.',
  alert_type: 'health_check_status_notification',
  ts: 1751414500,
  policy_id: 'pol-456',
  account_id: 'acc-abc',
  data: { zone_name: 'example.com', status: 'Unhealthy' },
};

const weirdAlert = {
  something: { nested: true },
  name: 42, // wrong type on purpose
  data: 'not-an-object',
  ts: null,
};

const testDelivery = {
  text: 'Hello World! This is a test message from Cloudflare! If you can read this, it means we are good to go!',
};


{
  const v = verify(JSON.stringify(pagesAlert), { 'cf-webhook-auth': SECRET }, connection);
  assert.deepEqual(v, { ok: true }, 'verify accepts the right cf-webhook-auth header');
}

{
  const v = verify(JSON.stringify(pagesAlert), { 'cf-webhook-auth': 'wrong' }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a wrong cf-webhook-auth header');
}

{
  const v = verify(JSON.stringify(pagesAlert), {}, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a missing cf-webhook-auth header');
}

{
  const v = verify(JSON.stringify(testDelivery), { 'cf-webhook-auth': SECRET }, connection);
  assert.ok('handshake' in v && v.handshake, 'verified test delivery is answered as a handshake');
  assert.ok(v.body.includes('ok'), 'handshake body is a benign OK payload');
}

{
  const v = verify(JSON.stringify(testDelivery), { 'cf-webhook-auth': 'wrong' }, connection);
  assert.equal('ok' in v && (v as { ok: boolean }).ok, false, 'handshake does not bypass auth');
}


{
  const events = asArray(normalize(pagesAlert, {}, connection));
  assert.equal(events.length, 2, 'pages alert emits alert + deployment');
  assert.deepEqual(events.map((e) => e.event_type).sort(), ['alert', 'deployment']);
  const dep = events.find((e) => e.event_type === 'deployment')!;
  assert.equal(dep.title, 'Pages deploy failed');
  assert.equal(dep.match?.alert_type, 'pages_event_alert');
  assert.equal(dep.match?.account_id, 'acc-abc');
  assert.equal(dep.match?.policy_id, 'pol-123');
  assert.equal(dep.match?.project, 'my-pages-app');
  assert.equal(dep.project_hint, 'my-pages-app');
  assert.ok(dep.delivery_id && dep.delivery_id !== events[0].delivery_id,
    'alert and deployment events carry distinct delivery ids');
  assert.equal(dep.raw, pagesAlert, 'raw payload preserved');
}

{
  const events = asArray(normalize(healthAlert, {}, connection));
  assert.deepEqual(events.map((e) => e.event_type).sort(), ['alert', 'health_check']);
  const hc = events.find((e) => e.event_type === 'health_check')!;
  assert.equal(hc.match?.zone, 'example.com');
  assert.equal(hc.summary, healthAlert.text);
}

{
  const events = asArray(normalize({ alert_type: 'advanced_ddos_attack_l7_alert', ts: 1 }, {}, connection));
  assert.deepEqual(events.map((e) => e.event_type).sort(), ['alert', 'security']);
}

{
  const events = asArray(normalize(weirdAlert, {}, connection));
  assert.equal(events.length, 1, 'unknown shape emits only the generic alert');
  assert.equal(events[0].event_type, 'alert');
  assert.equal(events[0].title, 'Cloudflare alert', 'defensive fallback title');
  assert.equal(events[0].delivery_id, undefined, 'no fabricated delivery id without stable fields');
}

{
  assert.equal(asArray(normalize(null, {}, connection))[0].event_type, 'alert');
  assert.equal(asArray(normalize('plain text', {}, connection))[0].event_type, 'alert');
  assert.equal(asArray(normalize([1, 2, 3], {}, connection))[0].event_type, 'alert');
}

console.log('cloudflare-integration trigger smoke test: all assertions passed');
