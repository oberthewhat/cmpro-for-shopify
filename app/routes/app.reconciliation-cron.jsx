const json = (data, init) => Response.json(data, init);
import { unauthenticated }    from '../shopify.server.js';
import { runReconciliation }  from '../reconciliation.server.js';
import db                     from '../db.server.js';

export const unstable_noClientBundle = true;

export const loader = async ({ request }) => {

  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

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
      console.error(`[CMPro] Cron error for ${shop}:`, err);
      results.push({ shop, status: 'error', error: err.message });
    }
  }

  return json({ ok: true, results });
};
