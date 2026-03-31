/**
 * reconciliation.server.js
 *
 * Reconciliation poll — fallback safety net.
 * Mirrors class-reconciliation.php exactly:
 *   - Fetch published blog IDs from CMPro
 *   - Compare against local Shopify metafields
 *   - Fetch + publish only missing blogs
 *   - Runs on a slow interval (every 6 hours)
 *
 * Scheduled via Vercel Cron, Render.com workers, or AWS EventBridge
 * depending on deployment environment.
 */

import { getToken }      from './auth.server.js';
import { publishBlog }   from './publisher.server.js';
import { cmproLog }      from './log.server.js';
import { getSessionData } from './session.server.js';

// Reconciliation interval — same 6-hour default as WP plugin
export const RECONCILIATION_INTERVAL_HOURS = 6;


// ── Main Reconciliation Run ─────────────────────────────────────────────────

/**
 * Run the reconciliation poll.
 * Entry point — mirrors CMPRO_Reconciliation::run() in the WP plugin.
 *
 * @param {object} graphql  Shopify Admin GraphQL client
 * @param {object} session
 */
export async function runReconciliation(graphql, session) {

  await cmproLog(session, 'Reconciliation run started.');

  const data = await getSessionData(session);

  if (!data?.account_id) {
    await cmproLog(session, 'Reconciliation skipped — no account ID configured.', 'warning');
    return;
  }

  // Fetch published blog IDs from CMPro
  let remoteIds;
  try {
    remoteIds = await fetchPublishedIds(session, data.account_id);
  } catch (err) {
    await cmproLog(session, `Reconciliation failed — could not fetch IDs: ${err.message}`, 'error');
    return;
  }

  if (!remoteIds || remoteIds.length === 0) {
    await cmproLog(session, 'Reconciliation complete — no published blogs found in CMPro.');
    return;
  }

  // Get locally stored CMPro IDs from Shopify metafields
  const localIds   = await getLocalIds(graphql);
  const missingIds = remoteIds.filter(id => !localIds.includes(id));

  if (missingIds.length === 0) {
    await cmproLog(session, `Reconciliation complete — all ${remoteIds.length} blogs accounted for.`);
    return;
  }

  await cmproLog(session, `Reconciliation found ${missingIds.length} missing blog(s). Fetching...`);

  const cmproBlogId = data.shopify_blog_id || '';
  let synced = 0;
  let failed = 0;

  for (const cmproId of missingIds) {
    try {
      const blog = await fetchBlog(session, cmproId);
      await publishBlog(graphql, session, blog, cmproBlogId);
      synced++;
    } catch (err) {
      await cmproLog(session, `Reconciliation failed for blog ID ${cmproId}: ${err.message}`, 'error');
      failed++;
    }
  }

  await cmproLog(session, `Reconciliation complete — synced: ${synced}, failed: ${failed}.`);
}


// ── CMPro API Calls (STUBS) ─────────────────────────────────────────────────

/**
 * Fetch all published blog IDs for this account's collections from CMPro.
 * STUB — endpoint TBC with David Wood.
 *
 * TODO: Replace with confirmed list endpoint from David.
 *
 * @param {object} session
 * @param {string} accountId
 * @returns {Promise<string[]>}
 */
async function fetchPublishedIds(session, accountId) {
  await cmproLog(session, 'Reconciliation list endpoint is a stub — skipping.', 'warning');
  throw new Error('Reconciliation list endpoint pending. Contact David Wood.');
}


/**
 * Fetch full blog content for a single CMPro blog ID.
 * STUB — endpoint TBC with David Wood.
 *
 * @param {object} session
 * @param {string} cmproId
 * @returns {Promise<object>} blog object matching the webhook payload schema
 */
async function fetchBlog(session, cmproId) {
  const token = await getToken(session);
  throw new Error('Blog fetch endpoint pending. Contact David Wood.');
}


// ── Local ID Lookup ─────────────────────────────────────────────────────────

/**
 * Get all CMPro blog IDs already stored in this Shopify store (via metafields).
 * Paginates through all articles to build the full set.
 * Mirrors get_local_ids() in class-reconciliation.php.
 *
 * @param {object} graphql
 * @returns {Promise<string[]>}
 */
async function getLocalIds(graphql) {
  const ids    = [];
  let cursor   = null;
  let hasMore  = true;

  while (hasMore) {
    const query = `
      query GetCmproArticleIds($cursor: String) {
        articles(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              metafield(namespace: "cmpro", key: "blog_id") {
                value
              }
            }
          }
        }
      }
    `;

    try {
      const response = await graphql(query, {
        variables: { cursor },
      });

      const { data } = await response.json();
      const articles = data?.articles;

      if (!articles) break;

      for (const edge of articles.edges) {
        const metaValue = edge.node?.metafield?.value;
        if (metaValue) ids.push(metaValue);
      }

      hasMore = articles.pageInfo.hasNextPage;
      cursor  = articles.pageInfo.endCursor;

    } catch (err) {
      // Non-fatal — return what we have
      break;
    }
  }

  return ids;
}
