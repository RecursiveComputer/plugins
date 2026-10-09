import crypto from 'node:crypto';
import type {
  NormalizedTriggerEvent,
  TriggerConnection,
  TriggerSourceModule,
  TriggerVerifyResult,
} from '@recursivecomputer/plugin-sdk';

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
  const settingsSecret = connection.settings?.signing_secret;
  const secret = (typeof settingsSecret === 'string' && settingsSecret) ? settingsSecret : connection.secret;

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
    const expected = signPayload(secret, timestamp, rawBody);
    if (!v1.some((candidate) => safeEqual(expected, candidate))) {
      return { ok: false, reason: 'Bad Stripe signature' };
    }
  }

  return { ok: true };
}

const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

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

function refId(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') return str((v as Record<string, unknown>).id);
  return undefined;
}

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
  const account = str(body.account);

  const { title, summary } = describe(eventType, obj);

  const url = `https://dashboard.stripe.com/${livemode ? '' : 'test/'}events/${eventId}`;

  return {
    event_type: eventType,
    title,
    summary,
    url,
    delivery_id: eventId,
    match: {
      event_type: eventType,
      livemode: livemode ? 'true' : 'false',
      ...(currency ? { currency } : {}),
      ...(customer ? { customer } : {}),
      ...(account ? { account } : {}),
    },
    raw: { event_id: eventId, event_type: eventType, livemode, object: obj, payload },
  };
}

const stripeTriggerSource: TriggerSourceModule = { verify, normalize };
export default stripeTriggerSource;
