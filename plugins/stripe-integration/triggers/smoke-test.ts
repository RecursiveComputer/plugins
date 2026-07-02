/**
 * Standalone smoke test for the Stripe trigger source.
 *
 *   bun plugins/shared/stripe-integration/triggers/smoke-test.ts
 *
 * Exercises verify() (Stripe-Signature t=/v1= HMAC accept/reject, secret-roll
 * multi-v1 headers, malformed headers, and the 5-minute replay window) and
 * normalize() (declared event types, amount formatting, dashboard permalinks,
 * and filter keys).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verify, normalize } from './index.ts';
import type { TriggerConnection, NormalizedTriggerEvent } from '@recursive/core-types/automation';

const SECRET = 'whsec_smoke_test_signing_secret';
const connection: TriggerConnection = {
  id: 'default',
  plugin_id: 'stripe-integration',
  settings: { signing_secret: SECRET },
};

/** v1 = HMAC_SHA256(secret, "<t>.<raw body>") — exactly what Stripe signs. */
function v1(body: string, timestamp: number, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** Build a `Stripe-Signature` header like Stripe's: t=<ts>,v1=<sig>[,…]. */
function sigHeader(body: string, timestamp: number, secret = SECRET): string {
  return `t=${timestamp},v1=${v1(body, timestamp, secret)}`;
}

const nowS = () => Math.floor(Date.now() / 1000);

const one = (v: NormalizedTriggerEvent | NormalizedTriggerEvent[] | null): NormalizedTriggerEvent => {
  assert.ok(v && !Array.isArray(v), 'normalize returns a single event');
  return v;
};

// ── Sample payloads ──────────────────────────────────────────────────

const checkoutEvent = {
  id: 'evt_1AbCdEfGhIjKlMnO',
  object: 'event',
  type: 'checkout.session.completed',
  livemode: false,
  data: {
    object: {
      id: 'cs_test_123',
      object: 'checkout.session',
      mode: 'subscription',
      amount_total: 4900,
      currency: 'usd',
      customer: 'cus_ABC123',
      customer_email: 'jane@example.com',
    },
  },
};

const disputeEvent = {
  id: 'evt_2DisputeXyZ',
  object: 'event',
  type: 'charge.dispute.created',
  livemode: true,
  data: {
    object: {
      id: 'du_1XyZ',
      object: 'dispute',
      amount: 12000,
      currency: 'eur',
      reason: 'fraudulent',
      charge: 'ch_1Charge',
    },
  },
};

// ── verify() ─────────────────────────────────────────────────────────

// Correct fresh signature → ok.
{
  const body = JSON.stringify(checkoutEvent);
  const v = verify(body, { 'stripe-signature': sigHeader(body, nowS()) }, connection);
  assert.deepEqual(v, { ok: true }, 'verify accepts a fresh, correctly signed request');
}

// Wrong secret → rejected.
{
  const body = JSON.stringify(checkoutEvent);
  const v = verify(body, { 'stripe-signature': sigHeader(body, nowS(), 'whsec_wrong') }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a signature made with the wrong secret');
}

// Tampered body → rejected (the HMAC covers "<t>.<raw body>").
{
  const body = JSON.stringify(checkoutEvent);
  const tampered = JSON.stringify({ ...checkoutEvent, livemode: true });
  const v = verify(tampered, { 'stripe-signature': sigHeader(body, nowS()) }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects when the body was tampered with');
}

// Missing header → rejected.
{
  const v = verify(JSON.stringify(checkoutEvent), {}, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a missing Stripe-Signature header');
}

// Malformed header (no t / no v1) → rejected.
{
  const body = JSON.stringify(checkoutEvent);
  for (const header of ['v1=deadbeef', `t=${nowS()}`, 'garbage', 't=,v1=']) {
    const v = verify(body, { 'stripe-signature': header }, connection);
    assert.equal('ok' in v && v.ok, false, `verify rejects malformed header: ${header}`);
  }
}

// Stale timestamp (> 5 min old) → replay rejected even with a valid HMAC.
{
  const body = JSON.stringify(checkoutEvent);
  const stale = nowS() - 6 * 60;
  const v = verify(body, { 'stripe-signature': sigHeader(body, stale) }, connection);
  assert.equal('ok' in v && v.ok, false, 'verify rejects a correctly-signed but stale request');
  assert.ok('reason' in v && /replay|stale/i.test(v.reason ?? ''), 'rejection names the replay window');
}

// Multiple v1 values (secret roll): any matching v1 accepts.
{
  const body = JSON.stringify(checkoutEvent);
  const ts = nowS();
  const header = `t=${ts},v1=${v1(body, ts, 'whsec_old_secret')},v1=${v1(body, ts)}`;
  const v = verify(body, { 'stripe-signature': header }, connection);
  assert.deepEqual(v, { ok: true }, 'any matching v1 candidate accepts (secret roll)');
}

// Multiple v1 values, none matching → rejected.
{
  const body = JSON.stringify(checkoutEvent);
  const ts = nowS();
  const header = `t=${ts},v1=${v1(body, ts, 'whsec_a')},v1=${v1(body, ts, 'whsec_b')}`;
  const v = verify(body, { 'stripe-signature': header }, connection);
  assert.equal('ok' in v && v.ok, false, 'all-wrong v1 candidates are rejected');
}

// ── normalize() ──────────────────────────────────────────────────────

// checkout.session.completed → typed event, amount in title, test-mode URL.
{
  const e = one(normalize(checkoutEvent, {}, connection));
  assert.equal(e.event_type, 'checkout.session.completed', 'event_type comes from payload.type');
  assert.ok(e.title?.includes('$49.00'), 'title formats the minor-unit amount');
  assert.ok(e.title?.includes('jane@example.com'), 'title names the customer');
  assert.equal(e.url, 'https://dashboard.stripe.com/test/events/evt_1AbCdEfGhIjKlMnO', 'test-mode events link under /test/');
  assert.equal(e.delivery_id, 'evt_1AbCdEfGhIjKlMnO', 'Stripe event id becomes delivery_id');
  assert.deepEqual(e.match, {
    event_type: 'checkout.session.completed',
    livemode: 'false',
    currency: 'usd',
    customer: 'cus_ABC123',
  });
}

// charge.dispute.created → live-mode URL, reason surfaced.
{
  const e = one(normalize(disputeEvent, {}, connection));
  assert.equal(e.event_type, 'charge.dispute.created');
  assert.ok(e.title?.includes('fraudulent'), 'title carries the dispute reason');
  assert.ok(e.title?.includes('€120.00') || e.title?.includes('120'), 'title formats the disputed amount');
  assert.equal(e.url, 'https://dashboard.stripe.com/events/evt_2DisputeXyZ', 'live-mode events link without /test/');
  assert.equal(e.match?.livemode, 'true');
  assert.equal(e.match?.currency, 'eur');
}

// Undeclared-but-valid Stripe event types still normalize (generic describe).
{
  const e = one(normalize({ id: 'evt_3', type: 'payment_intent.succeeded', data: { object: {} } }, {}, connection));
  assert.equal(e.event_type, 'payment_intent.succeeded');
  assert.ok(e.title, 'generic events still get a title');
}

// Non-Stripe / partial shapes → nothing to dispatch, nothing throws.
{
  assert.equal(normalize({}, {}, connection), null, 'payload without id+type is dropped');
  assert.equal(normalize({ type: 'checkout.session.completed' }, {}, connection), null, 'missing event id is dropped');
  assert.equal(normalize(null, {}, connection), null);
  assert.equal(normalize('plain text', {}, connection), null);
}

console.log('stripe-integration trigger smoke test: all assertions passed');
