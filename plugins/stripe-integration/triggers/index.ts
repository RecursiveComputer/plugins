/**
 * Stripe trigger source — verify() + normalize() for the Recursive inbound
 * trigger ingress route.
 *
 *   POST /api/triggers/inbound/stripe-integration/:connectionId
 *
 * All Stripe specifics live here so core stays integration-agnostic:
 *   - Request signing: the `Stripe-Signature` header carries
 *     `t=<unix_ts>,v1=<hex>[,v1=<hex>…]` where each v1 is
 *     HMAC_SHA256(signing_secret, "<t>.<raw_body>"), per
 *     https://docs.stripe.com/webhooks#verify-manually — with a 5-minute
 *     replay window on `t` (mirrors the Slack source's approach).
 *     Multiple v1 candidates occur during secret rolls; any match accepts.
 *   - Event normalization: `{ id: "evt_…", type, data: { object } }` →
 *     NormalizedTriggerEvent with amounts formatted from cents and a
 *     dashboard permalink (test-mode URLs get the /test/ prefix).
 *   - Stripe has no URL-verification handshake — the first delivery
 *     (e.g. the dashboard's "Send test webhook") is verified like any other.
 *
 * The connection secret is the webhook endpoint's **signing secret** (whsec_…).
 */
import crypto from 'node:crypto';
import type {
  TriggerSourceModule,
  TriggerVerifyResult,
  TriggerConnection,
  NormalizedTriggerEvent,
} from '@recursive/core-types/automation';

const FIVE_MIN_S = 60 * 5;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function signPayload(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** Parse `t=1234,v1=abc,v1=def,v0=…` into its timestamp and v1 candidates. */
function parseSignatureHeader(header: string): { timestamp?: string; v1: string[] } {
  let timestamp: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && value) timestamp = value;
    else if (key === 'v1' && value) v1.push(value);
  }
  return { timestamp, v1 };
}

export function verify(
  rawBody: string,
  headers: Record<string, string | undefined>,
  connection: TriggerConnection,
): TriggerVerifyResult {
  // The signing secret lives in the plugin's settings (configured once via the
  // plugin settings UI / `connecting-stripe` skill), not per-automation.
  const settingsSecret = connection.settings?.signing_secret;
  const secret = (typeof settingsSecret === 'string' && settingsSecret) ? settingsSecret : connection.secret;

  // Signature check (skipped only when no signing secret is configured).
  if (secret) {
    const header = headers['stripe-signature'];
    if (!header) {
      return { ok: false, reason: 'Missing Stripe-Signature header' };
    }
    const { timestamp, v1 } = parseSignatureHeader(header);
    if (!timestamp || v1.length === 0) {
      return { ok: false, reason: 'Malformed Stripe-Signature header' };
    }
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > FIVE_MIN_S) {
      return { ok: false, reason: 'Stale Stripe request (replay window exceeded)' };
    }
    // The signed payload is "<t>.<raw body>" — verification only works on the
    // exact raw bytes; any re-serialization of the JSON breaks it.
    const expected = signPayload(secret, timestamp, rawBody);
    if (!v1.some((candidate) => safeEqual(expected, candidate))) {
      return { ok: false, reason: 'Bad Stripe signature' };
    }
  }

  // Stripe has no setup handshake — nothing to echo.
  return { ok: true };
}

/** ISO 4217 currencies Stripe treats as zero-decimal (amounts not in cents). */
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/** Format a Stripe minor-unit amount, e.g. (4900, "usd") → "$49.00 USD". */
function formatAmount(amount: unknown, currency: unknown): string | undefined {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return undefined;
  const code = typeof currency === 'string' && currency ? currency.toLowerCase() : 'usd';
  const major = ZERO_DECIMAL.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code.toUpperCase() }).format(major)
      + ' ' + code.toUpperCase();
  } catch {
    return `${major} ${code.toUpperCase()}`;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Stripe object references may be expanded objects — reduce to the id. */
function refId(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') return str((v as Record<string, unknown>).id);
  return undefined;
}

/** Per-type one-liners built from the event's `data.object`. */
function describe(eventType: string, obj: Record<string, unknown>): { title: string; summary: string } {
  const email = str(obj.customer_email)
    ?? str((obj.customer_details as Record<string, unknown> | undefined)?.email);
  const who = email ?? refId(obj.customer) ?? 'unknown customer';

  switch (eventType) {
    case 'checkout.session.completed': {
      const amount = formatAmount(obj.amount_total, obj.currency);
      const title = amount ? `Checkout completed — ${amount} from ${who}` : `Checkout completed by ${who}`;
      return { title, summary: `Stripe Checkout Session ${str(obj.id) ?? ''} completed (mode: ${str(obj.mode) ?? 'payment'}).`.trim() };
    }
    case 'invoice.payment_failed': {
      const amount = formatAmount(obj.amount_due, obj.currency);
      const title = amount ? `Invoice payment failed — ${amount} for ${who}` : `Invoice payment failed for ${who}`;
      return { title, summary: `Payment for invoice ${str(obj.id) ?? ''} failed (attempts: ${typeof obj.attempt_count === 'number' ? obj.attempt_count : '?'}).`.trim() };
    }
    case 'customer.subscription.created':
      return {
        title: `Subscription created — ${str(obj.id) ?? 'subscription'} for ${who}`,
        summary: `New subscription ${str(obj.id) ?? ''} (status: ${str(obj.status) ?? 'unknown'}).`.trim(),
      };
    case 'customer.subscription.deleted':
      return {
        title: `Subscription canceled — ${str(obj.id) ?? 'subscription'} for ${who}`,
        summary: `Subscription ${str(obj.id) ?? ''} ended (status: ${str(obj.status) ?? 'canceled'}).`.trim(),
      };
    case 'charge.refunded': {
      const amount = formatAmount(obj.amount_refunded, obj.currency);
      return {
        title: amount ? `Charge refunded — ${amount} to ${who}` : `Charge refunded for ${who}`,
        summary: `Charge ${str(obj.id) ?? ''} refunded.`.trim(),
      };
    }
    case 'charge.dispute.created': {
      const amount = formatAmount(obj.amount, obj.currency);
      const reason = str(obj.reason);
      return {
        title: amount ? `Dispute opened — ${amount}${reason ? ` (${reason})` : ''}` : 'Dispute opened',
        summary: `Dispute ${str(obj.id) ?? ''} opened on charge ${refId(obj.charge) ?? ''}${reason ? ` — reason: ${reason}` : ''}.`.trim(),
      };
    }
    default:
      return { title: `Stripe event: ${eventType}`, summary: `Stripe ${eventType} event.` };
  }
}

export function normalize(
  payload: unknown,
  _headers: Record<string, string | undefined>,
  _connection: TriggerConnection,
): NormalizedTriggerEvent | null {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const eventType = str(body.type);
  const eventId = str(body.id);
  if (!eventType || !eventId) return null;

  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const obj = (data.object && typeof data.object === 'object' ? data.object : {}) as Record<string, unknown>;

  const livemode = body.livemode === true;
  const currency = str(obj.currency);
  const customer = refId(obj.customer);
  // Connect: the account the event originated from, present on Connect events.
  const account = str(body.account);

  const { title, summary } = describe(eventType, obj);

  // Dashboard permalink — test-mode events live under /test/.
  const url = `https://dashboard.stripe.com/${livemode ? '' : 'test/'}events/${eventId}`;

  return {
    event_type: eventType,
    title,
    summary,
    url,
    // Stripe's event id — used by the ingress route for retry de-duplication.
    delivery_id: eventId,
    match: {
      event_type: eventType,
      livemode: livemode ? 'true' : 'false',
      ...(currency ? { currency } : {}),
      ...(customer ? { customer } : {}),
      ...(account ? { account } : {}),
    },
    // Carry the full Stripe event so the dispatched agent sees exactly what fired.
    raw: { event_id: eventId, event_type: eventType, livemode, object: obj, payload },
  };
}

const stripeTriggerSource: TriggerSourceModule = { verify, normalize };
export default stripeTriggerSource;
