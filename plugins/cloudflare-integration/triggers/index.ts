/**
 * Cloudflare trigger source — verify() + normalize() for the Recursive inbound
 * trigger ingress route.
 *
 *   POST /api/triggers/inbound/cloudflare-integration/:connectionId
 *
 * All Cloudflare specifics live here so core stays integration-agnostic:
 *   - Shared-secret auth: Cloudflare Notification webhook destinations send
 *     the destination's secret verbatim in the `cf-webhook-auth` header on
 *     every delivery (plain equality, NOT an HMAC signature). We compare it
 *     against the plugin's `webhook_secret` setting with a constant-time
 *     compare.
 *   - Destination-creation handshake: saving a webhook destination in the
 *     Cloudflare dashboard fires a one-time test POST ("Hello World! This is
 *     a test message from Cloudflare! …"). A verified request that looks like
 *     that test is answered as a handshake (200, no dispatch) so the
 *     destination saves cleanly and the connection gets its verified stamp.
 *   - Notification normalization: payload shapes vary by alert type
 *     (Workers/Pages deploys, health checks, security events, usage alerts),
 *     so every field is read defensively. `alert_type` is bucketed into the
 *     typed convenience events (`deployment` / `health_check` / `security`);
 *     every notification ALSO emits the generic `alert` event so an
 *     "any notification" automation always fires.
 *
 * The connection secret is the **webhook destination secret** the user chose.
 */
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

function parseBody(rawBody: string): Record<string, unknown> {
  try {
    const v = JSON.parse(rawBody);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Cloudflare's destination-creation test delivery has no alert_type and a
 * recognizable "test message from Cloudflare" text (shape not guaranteed —
 * match loosely). */
function isDestinationTest(body: Record<string, unknown>): boolean {
  if (str(body.alert_type)) return false;
  const text = str(body.text);
  if (!text) return Object.keys(body).length === 0;
  const t = text.toLowerCase();
  return t.includes('test') && t.includes('cloudflare');
}

export function verify(
  rawBody: string,
  headers: Record<string, string | undefined>,
  connection: TriggerConnection,
): TriggerVerifyResult {
  // The webhook secret lives in the plugin's settings (configured once via the
  // plugin settings UI / `connecting-cloudflare` skill), not per-automation.
  const settingsSecret = connection.settings?.webhook_secret;
  const secret = (typeof settingsSecret === 'string' && settingsSecret) ? settingsSecret : connection.secret;
  const auth = headers['cf-webhook-auth'];

  // Shared-secret check (skipped only when no secret is configured).
  if (secret) {
    if (!auth) {
      return { ok: false, reason: 'Missing cf-webhook-auth header' };
    }
    if (!safeEqual(secret, auth)) {
      return { ok: false, reason: 'Bad cf-webhook-auth secret' };
    }
  }

  // Destination-creation handshake — Cloudflare POSTs a test message when the
  // webhook destination is saved. Answer 200 without dispatching so the
  // destination saves and the connection is stamped verified.
  if (isDestinationTest(parseBody(rawBody))) {
    return {
      handshake: true,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ ok: true, note: 'Cloudflare webhook destination verified' }),
    };
  }

  return { ok: true };
}

/** Bucket a Cloudflare alert_type into one of the typed convenience events. */
function categorize(alertType: string): 'deployment' | 'health_check' | 'security' | null {
  const t = alertType.toLowerCase();
  if (t.startsWith('pages_') || t.startsWith('workers_') || t.includes('deploy')) return 'deployment';
  if (t.startsWith('health_check') || t.includes('health_check')) return 'health_check';
  if (
    t.startsWith('dos_') || t.includes('ddos') || t.includes('security')
    || t.includes('firewall') || t.includes('fw_anomaly') || t.includes('waf')
  ) return 'security';
  return null;
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function normalize(
  payload: unknown,
  _headers: Record<string, string | undefined>,
  _connection: TriggerConnection,
): NormalizedTriggerEvent[] {
  const body = (payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload : {}) as Record<string, unknown>;

  // Shapes vary by alert type — read everything defensively.
  const alertType = str(body.alert_type);
  const name = str(body.name);
  const text = str(body.text);
  const accountId = str(body.account_id);
  const policyId = str(body.policy_id);
  const ts = typeof body.ts === 'number' ? String(body.ts) : str(body.ts) ?? str(body.timestamp);
  const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data : {}) as Record<string, unknown>;

  // Zone / Pages-project hints, when the alert carries them.
  const zone = str(data.zone_name) ?? str(data.zone) ?? str(body.zone_name);
  const project = str(data.project_name) ?? str(data.project) ?? str(body.project_name);

  const title = name ?? (text ? truncate(text, 80) : 'Cloudflare alert');
  let summary = text;
  if (!summary && Object.keys(data).length > 0) {
    try { summary = truncate(JSON.stringify(data), 300); } catch { /* unstringifiable data */ }
  }

  const match: Record<string, string> = {
    ...(alertType ? { alert_type: alertType } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(policyId ? { policy_id: policyId } : {}),
    ...(zone ? { zone } : {}),
    ...(project ? { project } : {}),
  };

  // Stable-ish per-delivery id for retry de-duplication — Cloudflare sends no
  // delivery-id header, so derive one from the payload when it's specific
  // enough. Each emitted event gets a distinct suffix so the generic `alert`
  // and the typed convenience event aren't deduped against each other.
  const deliveryBase = ts && (policyId || alertType)
    ? `cf:${policyId ?? '-'}:${alertType ?? '-'}:${ts}`
    : undefined;

  const base: Omit<NormalizedTriggerEvent, 'event_type'> = {
    title,
    summary,
    url: accountId ? `https://dash.cloudflare.com/${accountId}/notifications` : undefined,
    ...(project ? { project_hint: project } : {}),
    match,
    raw: payload,
  };

  // Every notification fires the generic `alert` event…
  const events: NormalizedTriggerEvent[] = [{
    ...base,
    event_type: 'alert',
    ...(deliveryBase ? { delivery_id: `${deliveryBase}:alert` } : {}),
  }];

  // …plus its typed convenience event when the alert_type buckets into one.
  const category = alertType ? categorize(alertType) : null;
  if (category) {
    events.push({
      ...base,
      event_type: category,
      ...(deliveryBase ? { delivery_id: `${deliveryBase}:${category}` } : {}),
    });
  }

  return events;
}

const cloudflareTriggerSource: TriggerSourceModule = { verify, normalize };
export default cloudflareTriggerSource;
