/**
 * signature.server.js
 *
 * Webhook signature verification.
 * Mirrors cmpro_verify_signature() in class-webhook.php.
 *
 * TODO: Confirm with David / Jake before finalising:
 *   - Exact header name (currently assuming x-m360-signature)
 *   - Hashing algorithm (assuming HMAC-SHA256)
 *   - Encoding format of the signature (currently assuming hex)
 *   - Verify the exact spec used by the M360 payments plugin
 */

import crypto              from 'crypto';
import { cmproLog }        from './log.server.js';
import { getSessionData }  from './session.server.js';

const SIGNATURE_HEADER = 'x-m360-signature';


/**
 * Verify an incoming webhook signature.
 * Returns true if valid, false if not.
 *
 * If no webhook secret is configured, logs a warning and allows through
 * (same stub behaviour as the WP plugin during development).
 *
 * @param {object} session
 * @param {Request} request  Raw Remix/Node request object
 * @param {string}  rawBody  Raw request body string
 * @returns {Promise<boolean>}
 */
export async function verifySignature(session, request, rawBody) {
  const receivedSig = request.headers.get(SIGNATURE_HEADER);

  // Get webhook secret from session storage
  const data   = await getSessionData(session);
  const secret = data?.webhook_secret || '';

  if (!secret) {
    await cmproLog(
      session,
      'Webhook secret not configured — skipping signature verification (stub mode).',
      'warning'
    );
    // Allow through in stub mode — same as WP plugin
    return true;
  }

  if (!receivedSig) {
    return false;
  }

  // HMAC-SHA256 hex digest — mirrors hash_hmac('sha256', ...) in PHP
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison — mirrors hash_equals() in PHP
  const sigBuffer      = Buffer.from(receivedSig);
  const computedBuffer = Buffer.from(computed);

  if (sigBuffer.length !== computedBuffer.length) return false;

  return crypto.timingSafeEqual(sigBuffer, computedBuffer);
}
