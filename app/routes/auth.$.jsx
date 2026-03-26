/**
 * auth.$.jsx
 *
 * Catch-all route for Shopify OAuth.
 * Handles /auth, /auth/callback, /auth/shopify/callback.
 *
 * Standard Shopify CLI scaffold — no CMPro-specific logic.
 */

import { authenticate } from '../shopify.server.js';

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};
