/**
 * session.server.js
 *
 * CMPro config storage backed by Prisma (CmproConfig table).
 * Replaces the stub wp_options approach with a proper per-shop DB row.
 *
 * All reads/writes are keyed by session.shop (the Shopify store domain),
 * matching how wp_options is implicitly scoped to one WP install.
 */

import db from './db.server.js';

/**
 * Get CMPro config for the current shop.
 * Returns null if not yet configured.
 *
 * Equivalent to: get_option('cmpro_*') calls throughout the WP plugin.
 *
 * @param {object} session  Shopify session (must have .shop)
 * @returns {Promise<object|null>}
 */
export async function getSessionData(session) {
  if (!session?.shop) return null;

  const config = await db.cmproConfig.findUnique({
    where: { shop: session.shop },
  });

  if (!config) return null;

  return {
    account_id:      config.accountId      || null,
    account_name:    config.accountName    || null,
    client_id:       config.clientId       || null,
    client_secret:   config.clientSecret   || null,
    access_token:    config.accessToken    || null,
    refresh_token:   config.refreshToken   || null,
    token_expiry:    config.tokenExpiry    ? config.tokenExpiry.getTime() : 0,
    webhook_secret:  config.webhookSecret  || null,
    webhook_id:      config.webhookId      || null,
    install_id:      config.installId      || null,
    shopify_blog_id: config.shopifyBlogId  || null,
    blog_count:      config.blogCount      || 0,
    last_sync_at:    config.lastSyncAt     || null,
  };
}

/**
 * Save CMPro config for the current shop.
 * Pass null to clear all stored data (disconnect).
 *
 * Equivalent to: update_option('cmpro_*', ...) in the WP plugin.
 *
 * @param {object}      session
 * @param {object|null} data
 */
export async function setSessionData(session, data) {
  if (!session?.shop) return;

  if (data === null) {
    // Disconnect — delete the config row
    await db.cmproConfig.deleteMany({
      where: { shop: session.shop },
    });
    return;
  }

  const upsertData = {
    accountId:     data.account_id      ?? undefined,
    accountName:   data.account_name    ?? undefined,
    clientId:      data.client_id       ?? undefined,
    clientSecret:  data.client_secret   ?? undefined,
    accessToken:   data.access_token    ?? undefined,
    refreshToken:  data.refresh_token   ?? undefined,
    tokenExpiry:   data.token_expiry    ? new Date(data.token_expiry) : undefined,
    webhookSecret: data.webhook_secret  ?? undefined,
    webhookId:     data.webhook_id      ?? undefined,
    installId:     data.install_id      ?? undefined,
    shopifyBlogId: data.shopify_blog_id ?? undefined,
    blogCount:     data.blog_count      ?? undefined,
    lastSyncAt:    data.last_sync_at    ? new Date(data.last_sync_at) : undefined,
  };

  // Remove undefined values so we don't overwrite existing data with nulls
  const clean = Object.fromEntries(
    Object.entries(upsertData).filter(([, v]) => v !== undefined)
  );

  await db.cmproConfig.upsert({
    where:  { shop: session.shop },
    update: clean,
    create: { shop: session.shop, ...clean },
  });
}

/**
 * Increment the blog count by the given amount.
 * Called by the publisher after a successful sync.
 *
 * @param {object} session
 * @param {number} count   Number to add (default: 1)
 */
export async function incrementBlogCount(session, count = 1) {
  if (!session?.shop) return;
  await db.cmproConfig.updateMany({
    where: { shop: session.shop },
    data:  { blogCount: { increment: count } },
  });
}
