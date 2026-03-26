/**
 * webhooks.cmpro-blog.jsx
 *
 * CMPro blog.publish webhook receiver.
 * Mirrors class-webhook.php — same signature verification, same deduplication,
 * same publish flow, same error response codes.
 *
 * Registered at: POST /webhooks/cmpro-blog/:shop
 * The shop domain is in the URL so we can look up the correct session.
 * CMPro registers this URL (including the shop param) during setup.
 *
 * Response codes (same as WP plugin):
 *   200 — received and processed (or duplicate — safe to ignore)
 *   400 — invalid payload
 *   401 — invalid signature or unknown shop
 *   500 — publish failed
 */

import { json }               from '@remix-run/node';
import { unauthenticated }    from '../shopify.server.js';
import { verifySignature }    from '../lib/signature.server.js';
import { publishBlog }        from '../lib/publisher.server.js';
import { cmproLog }           from '../lib/log.server.js';
import { getSessionData }     from '../lib/session.server.js';

// Only POST is valid on this route
export const action = async ({ request, params }) => {

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  // Shop domain is in the URL: /webhooks/cmpro-blog/:shop
  // e.g. /webhooks/cmpro-blog/my-store.myshopify.com
  const shop = params.shop;
  if (!shop) {
    return json({ error: 'Missing shop identifier' }, { status: 400 });
  }

  // Read raw body before any other processing
  const rawBody = await request.text();

  // Get a Shopify Admin API client for this shop without OAuth redirect
  // unauthenticated.admin() looks up the stored session by shop domain
  let admin, session;
  try {
    ({ admin, session } = await unauthenticated.admin(shop));
  } catch {
    return json({ error: 'Unknown shop' }, { status: 401 });
  }

  // ── Step 1: Verify CMPro signature ───────────────────────────────────────
  const isValid = await verifySignature(session, request, rawBody);
  if (!isValid) {
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    await cmproLog(session, `Webhook rejected — invalid signature. IP: ${ip}`, 'error');
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  // ── Step 2: Parse payload ─────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await cmproLog(session, 'Webhook rejected — JSON parse error.', 'error');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  if (!payload?.blog) {
    await cmproLog(session, 'Webhook rejected — missing blog object in payload.', 'error');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const blog = payload.blog;
  await cmproLog(session, `Webhook received for blog ID: ${blog.id || 'unknown'}`);

  // ── Step 3: Publish ───────────────────────────────────────────────────────
  try {
    const config      = await getSessionData(session);
    const cmproBlogId = config?.shopify_blog_id || '';

    await publishBlog(admin.graphql, session, blog, cmproBlogId);

  } catch (err) {
    await cmproLog(session, `Failed to publish blog ID ${blog.id}: ${err.message}`, 'error');
    return json({ error: 'Publish failed' }, { status: 500 });
  }

  return json({ status: 'received' }, { status: 200 });
};

export const loader = () => json({ error: 'Not found' }, { status: 404 });
