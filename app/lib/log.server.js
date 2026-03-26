/**
 * log.server.js
 *
 * Sync log — backed by the SyncLog Prisma table.
 * Mirrors cmpro_log() from class-auth.php.
 *
 * Uses a proper DB table instead of a JSON blob in wp_options,
 * but keeps the same API surface (cmproLog, getLog, clearLog).
 * Capped at 500 rows per shop (vs 100 in the WP plugin — more
 * space makes sense in a DB vs an options row).
 */

import { db } from './db.server.js';

const MAX_LOG_ROWS = 500;

/**
 * Append a message to the CMPro sync log.
 * Mirrors: cmpro_log($message, $level) in class-auth.php
 *
 * @param {object} session
 * @param {string} message
 * @param {'info'|'warning'|'error'} level
 */
export async function cmproLog(session, message, level = 'info') {
  if (!session?.shop) {
    console.log(`[CMPro][${level}] ${message}`);
    return;
  }

  try {
    await db.syncLog.create({
      data: { shop: session.shop, level, message },
    });

    // Prune old rows — keep only the most recent MAX_LOG_ROWS per shop
    const count = await db.syncLog.count({ where: { shop: session.shop } });

    if (count > MAX_LOG_ROWS) {
      // Find the ID of the (count - MAX_LOG_ROWS)th oldest row and delete everything older
      const oldest = await db.syncLog.findMany({
        where:   { shop: session.shop },
        orderBy: { createdAt: 'asc' },
        take:    count - MAX_LOG_ROWS,
        select:  { id: true },
      });
      const oldIds = oldest.map(r => r.id);
      await db.syncLog.deleteMany({ where: { id: { in: oldIds } } });
    }

  } catch (err) {
    // Log writes should never crash the main flow
    console.error(`[CMPro][${level}] ${message}`, err);
  }
}

/**
 * Get all log entries for a shop, newest first.
 *
 * @param {object} session
 * @param {number} limit  Max rows to return (default: 100)
 * @returns {Promise<Array>}
 */
export async function getLog(session, limit = 100) {
  if (!session?.shop) return [];

  const rows = await db.syncLog.findMany({
    where:   { shop: session.shop },
    orderBy: { createdAt: 'desc' },
    take:    limit,
  });

  return rows.map(r => ({
    time:    r.createdAt.toISOString(),
    level:   r.level,
    message: r.message,
  }));
}

/**
 * Clear all log entries for a shop.
 *
 * @param {object} session
 */
export async function clearLog(session) {
  if (!session?.shop) return;
  await db.syncLog.deleteMany({ where: { shop: session.shop } });
}
