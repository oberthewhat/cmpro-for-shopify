/**
 * webhooks.cmpro-blog.$shop.jsx
 *
 * CMPro blog webhook receiver — ported to the confirmed M360 protocol
 * from class-webhook.php (CMPRO_Webhook).
 *
 * Handles BOTH verbs on /webhooks/cmpro-blog/:shop :
 *   GET  → M360 endpoint verification handshake. Echoes the `confirm`
 *          query param verbatim as text/plain within 10s. M360 fires this
 *          synchronously during registration; it MUST be live first.
 *   POST → actual event notification (signature + replay verified).
 *
 * The shop domain is in the URL so we can resolve the correct session
 * without an OAuth redirect (unauthenticated.admin).
 *
 * Response codes (same as WP plugin):
 *   200 — received / duplicate (safe to ignore)
 *   400 — invalid payload / missing confirm
 *   401 — invalid signature or unknown shop
 *   500 — publish failed
 */

export const unstable_noClientBundle = true;

import { unauthenticated }               from '../shopify.server.js';
import { verifySignature, verifyTimestamp, TIMESTAMP_HEADER, EVENT_ID_HEADER } from '../signature.server.js';
import { publishBlog }                   from '../publisher.server.js';
import { cmproLog }                      from '../log.server.js';
import { getSessionData }                from '../session.server.js';

const json = (data, init) => Response.json(data, init);

// ── GET: verification handshake ──────────────────────────────────────────────
// M360 sends ?confirm=<token>; we echo it back verbatim as text/plain.
export const loader = async ({ request }) => {
  const url     = new URL(request.url);
  const confirm = url.searchParams.get('confirm');

  if (confirm === null || confirm === '') {
    return new Response('Missing confirm parameter', { status: 400 });
  }

  return new Response(confirm, {
    status:  200,
    headers: { 'Content-Type': 'text/plain' },
  });
};

// ── POST: event notification ─────────────────────────────────────────────────
export const action = async ({ request, params }) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const shop = params.shop;
  if (!shop) {
    return json({ error: 'Missing shop identifier' }, { status: 400 });
  }

  // Read the raw body BEFORE parsing — the signature is over the raw bytes.
  const rawBody = await request.text();

  // Resolve the Shopify Admin client + session for this shop (no OAuth redirect).
  let admin, session;
  try {
    ({ admin, session } = await unauthenticated.admin(shop));
  } catch {
    return json({ error: 'Unknown shop' }, { status: 401 });
  }

  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const eventId   = request.headers.get(EVENT_ID_HEADER) || 'n/a';

  // ── Step 1: Verify signature ──
  const isValid = await verifySignature(session, request, rawBody);
  if (!isValid) {
    const ip = request.headers.get('x-forwarded-for') || 'unknown';
    await cmproLog(session, `Webhook rejected — invalid signature. IP: ${ip}`, 'error');
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  // ── Step 2: Replay protection ──
  if (!verifyTimestamp(timestamp)) {
    await cmproLog(session, 'Webhook rejected — timestamp outside tolerance (possible replay).', 'error');
    return json({ error: 'Stale timestamp' }, { status: 401 });
  }

  // ── Step 3: Parse payload (flat schema — NOT wrapped in .blog) ──
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await cmproLog(session, 'Webhook rejected — JSON parse error.', 'error');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object') {
    await cmproLog(session, 'Webhook rejected — invalid or empty payload.', 'error');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  // Only handle blog content types.
  const contentType = payload.contentType || '';
  if (contentType !== 'blogs') {
    await cmproLog(session, `Webhook ignored — contentType is "${contentType}", not a blog. Event ID: ${eventId}`, 'info');
    return json({ status: 'ignored' }, { status: 200 });
  }

  const itemId = payload.itemId || '';
  if (!itemId) {
    const keys = Object.keys(payload).join(', ');
    await cmproLog(session, `Webhook payload missing itemId. Event ID: ${eventId}. Top-level keys: [${keys}]`, 'error');
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  await cmproLog(session, `Webhook received for blog itemId: ${itemId} (event ${eventId})`);

  // The article HTML arrives in the payload 'body' field (confirmed with Jake).
  // If empty, skip rather than publishing an empty post.
  const bodyHtml = payload.body || '';
  if (bodyHtml === '') {
    await cmproLog(session, `Blog itemId ${itemId} has no body content yet — skipping publish.`, 'warning');
    return json({ status: 'skipped' }, { status: 200 });
  }

  // Map the flat webhook payload into the publisher's expected shape —
  // mirrors the $blog array built in CMPRO_Webhook::process().
  const blog = {
    id:                 itemId,
    title:              payload.title         || '',
    slug:               payload.slug          || '',
    excerpt:            payload.excerpt       || '',
    publish_date:       payload.publishedDate || '',
    html_content:       bodyHtml,
    collection_id:      payload.topicId       || '',
    featured_image_url: payload.featuredImage || '',
    tags:               payload.tags          || [],
    author:             payload.author        || '',
  };

  // ── Step 4: Publish ──
  try {
    const config      = await getSessionData(session);
    const cmproBlogId = config?.shopify_blog_id || '';
    await publishBlog(admin.graphql, session, blog, cmproBlogId);
  } catch (err) {
    console.error('[CMPro] Publish error:', err);
    await cmproLog(session, `Failed to publish blog itemId ${itemId}: ${err.message}`, 'error');
    return json({ error: 'Publish failed' }, { status: 500 });
  }

  return json({ status: 'received' }, { status: 200 });
};
