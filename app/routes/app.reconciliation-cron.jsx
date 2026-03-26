/**
 * app.reconciliation-cron.jsx
 *
 * Cron trigger endpoint for the reconciliation poll.
 * Called by Vercel Cron on the configured interval (every 6 hours).
 *
 * Uses unauthenticated.admin() — no Shopify OAuth redirect, looks up the
 * stored session by shop domain from the query param.
 *
 * URL: GET /app/reconciliation-cron?shop=my-store.myshopify.com
 *
 * Configure in vercel.json:
 * {
 *   "crons": [{ "path": "/app/reconciliation-cron", "schedule": "0 */6 * * *" }]
 * }
 *
 * For multi-shop: extend to iterate over all shops in CmproConfig table.
 * Equivalent to the WP-Cron schedule in class-reconciliation.php.
 */

import { json }               from '@remix-run/node';
import { unauthenticated }    from '../shopify.server.js';
import { runReconciliation }  from '../lib/reconciliation.server.js';
import { db }                 from '../lib/db.server.js';

export const loader = async ({ request }) => {

  // Verify Vercel cron secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get all connected shops from the DB and reconcile each one
  const configs = await db.cmproConfig.findMany({
    where: { accountId: { not: null } },
    select: { shop: true },
  });

  if (configs.length === 0) {
    return json({ ok: true, message: 'No connected shops.' });
  }

  const results = [];

  for (const { shop } of configs) {
    try {
      const { admin, session } = await unauthenticated.admin(shop);
      await runReconciliation(admin.graphql, session);
      results.push({ shop, status: 'ok' });
    } catch (err) {
      console.error(`[CMPro] Cron reconciliation error for ${shop}:`, err);
      results.push({ shop, status: 'error', error: err.message });
    }
  }

  return json({ ok: true, results });
};
