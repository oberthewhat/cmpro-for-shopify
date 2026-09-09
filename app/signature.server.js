/**
 * signature.server.js
 *
 * Incoming webhook signature + replay verification.
 * Ported from class-webhook.php (CMPRO_Webhook::verify_signature /
 * verify_timestamp) so it matches the confirmed M360 spec exactly.
 *
 * Spec (confirmed in the WP plugin):
 *   Header  marketing360_signature  — HMAC-SHA256 hex digest
 *   Header  marketing360_timestamp  — unix seconds, used in the signed content
 *   Header  marketing360_event_id   — opaque event id (idempotency)
 *   Signed content = `${timestamp}.${rawBody}`
 *   Comparison     = constant-time (timingSafeEqual)
 *   Replay window  = ±300s
 */

import crypto from 'crypto';
import { cmproLog }       from './log.server.js';
import { getSessionData } from './session.server.js';

export const SIG_HEADER       = 'marketing360-signature';
export const TIMESTAMP_HEADER = 'marketing360-timestamp';
export const EVENT_ID_HEADER  = 'marketing360-event-id';

const REPLAY_TOLERANCE_SECONDS = 300; // ±5 minutes


/**
 * Verify an incoming webhook's signature.
 * Unlike the earlier stub, this FAILS CLOSED: if no secret is configured,
 * verification fails (a webhook can't be trusted without the signing secret).
 *
 * @param {object}  session
 * @param {Request} request  Node/Remix request (for headers)
 * @param {string}  rawBody  Raw request body string (unparsed)
 * @returns {Promise<boolean>}
 */
export async function verifySignature(session, request, rawBody) {
  const signature = request.headers.get(SIG_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);

  if (!signature || !timestamp) {
    await cmproLog(session, 'Webhook rejected — signature or timestamp header missing.', 'error');
    return false;
  }

  const data   = await getSessionData(session);
  const secret = data?.webhook_secret || '';

  if (!secret) {
    await cmproLog(session, 'Webhook secret not configured — cannot verify signature.', 'error');
    return false;
  }

  // Signed content is timestamp + "." + raw body — must match the WP plugin.
  const signedContent = `${timestamp}.${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(signedContent).digest('hex');

  // Constant-time comparison.
  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  // ── TEMP DIAGNOSTICS (remove once signature verified) ──────────────────────
  // Captures exactly what we received vs. computed so a mismatch is diagnosable
  // without leaking the secret. Logs alternate signing schemes so we can see
  // which one M360 is actually using.
  if (!match) {
    const bodyOnly     = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const tsSpaceBody  = crypto.createHmac('sha256', secret).update(`${timestamp} ${rawBody}`).digest('hex');
    const base64Digest = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');
    await cmproLog(session,
      `[SIG DEBUG] received=${signature.slice(0, 12)}…(len ${signature.length}) ` +
      `computed_ts.body=${computed.slice(0, 12)}…(len ${computed.length}) ` +
      `computed_bodyOnly=${bodyOnly.slice(0, 12)}… ` +
      `computed_ts_space=${tsSpaceBody.slice(0, 12)}… ` +
      `computed_b64=${base64Digest.slice(0, 12)}… ` +
      `ts=${timestamp} bodyLen=${rawBody.length} secretLen=${secret.length}`,
      'warning');
  }

  return match;
}


/**
 * Replay protection — reject events whose timestamp is too far from now.
 * Timestamp is seconds since Unix epoch. Mirrors verify_timestamp().
 *
 * @param {string|number} timestamp
 * @returns {boolean}
 */
export function verifyTimestamp(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '' || isNaN(Number(timestamp))) {
    return false;
  }
  const diff = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  return diff <= REPLAY_TOLERANCE_SECONDS;
}
