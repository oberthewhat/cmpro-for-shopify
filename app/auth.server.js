/**
 * auth.server.js
 *
 * M360 authentication + token management.
 * Mirrors class-auth.php — same endpoints, same flow, same stubs.
 *
 * Steps:
 *   1. login(username, password)         → temporary token
 *   2. getAccounts(token)                → list of M360 accounts
 *   3. connectAccount(accountData)       → saves creds, gets working token
 *   4. registerWebhook(accountId)        → STUB — endpoint TBC with David
 */

import { getSessionData, setSessionData } from './session.server.js';
import { cmproLog } from './log.server.js';

// ── M360 API Endpoints ──────────────────────────────────────────────────────

const AUTH_URL     = 'https://login.marketing360.com/auth/realms/marketing360/protocol/openid-connect/token';
const ACCOUNTS_URL = 'https://app.marketing360.com/api/accounts';

// Same client_id used by the M360 payments plugins
const LOGIN_CLIENT_ID = 'gravity_forms_payments';

// Token expiry buffer — refresh 30s before expiry
const TOKEN_EXPIRY_SECONDS = 240; // 4 min, same as WP plugin


// ── Step 1: Login with username + password ──────────────────────────────────

/**
 * Exchange M360 username/password for a temporary login token.
 * Used only during setup — not stored.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<string>} access token
 * @throws {Error} on failure
 */
export async function login(username, password) {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id:  LOGIN_CLIENT_ID,
    username,
    password,
  });

  const res  = await fetch(AUTH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    const message = data.error_description || data.error || 'Unknown error';
    throw new Error(`M360 authentication failed: ${message}`);
  }

  return data.access_token;
}


// ── Step 2: Fetch account list ──────────────────────────────────────────────

/**
 * Fetch all M360 accounts for the authenticated user.
 *
 * @param {string} token  Login token from login()
 * @returns {Promise<Array>} array of account objects
 * @throws {Error} on failure
 */
export async function getAccounts(token) {
  const res = await fetch(`${ACCOUNTS_URL}?limit=999`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Failed to retrieve accounts. Status: ${res.status}`);
  }

  // Accounts are under a 'response' key — same pattern as WP plugin
  return data.response || [];
}


// ── Step 3: Connect selected account ───────────────────────────────────────

/**
 * Save account credentials to session storage and get a working token.
 * Called after user selects an account from the list.
 *
 * @param {object} session   Shopify session object (for storage)
 * @param {object} account   Account data from getAccounts()
 * @param {string} account.accountId
 * @param {string} account.accountName
 * @param {string} [account.clientId]
 * @param {string} [account.clientSecret]
 */
export async function connectAccount(session, account) {
  const { accountId, accountName, clientId, clientSecret } = account;

  // Save credentials to Shopify session storage
  await setSessionData(session, {
    account_id:    accountId,
    account_name:  accountName,
    client_id:     clientId     || '',
    client_secret: clientSecret || '',
    // Placeholder token — replaced by real token once David's endpoint is ready
    access_token:  'pending',
    token_expiry:  Date.now() + (24 * 60 * 60 * 1000), // 24h placeholder
  });

  // Register webhook — stub for now
  await registerWebhook(session, accountId);

  await cmproLog(session, `Connected to M360 account: ${accountName} (${accountId})`);
}


// ── Token Management ────────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing if needed.
 * Mirrors CMPRO_Auth::get_token() in the WP plugin.
 *
 * @param {object} session
 * @returns {Promise<string>} access token
 * @throws {Error} if not connected or refresh fails
 */
export async function getToken(session) {
  const data = await getSessionData(session);

  if (!data) {
    throw new Error('CMPro is not connected. Please complete setup in the app settings.');
  }

  const { access_token, token_expiry, client_id, client_secret } = data;

  // Return existing token if still valid (with 30s buffer)
  if (access_token && access_token !== 'pending' && Date.now() < (token_expiry - 30000)) {
    return access_token;
  }

  if (!client_id || !client_secret) {
    throw new Error('No client credentials stored — reconnection required.');
  }

  // Refresh using client credentials grant
  const newToken = await getTokenViaClientCredentials(client_id, client_secret);

  await setSessionData(session, {
    ...data,
    access_token: newToken,
    token_expiry: Date.now() + (TOKEN_EXPIRY_SECONDS * 1000),
  });

  return newToken;
}


/**
 * OAuth2 client_credentials grant.
 * Used for ongoing API access after initial setup.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<string>} access token
 * @throws {Error} on failure
 */
export async function getTokenViaClientCredentials(clientId, clientSecret) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(AUTH_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    const message = data.error_description || data.error || 'Unknown error';
    throw new Error(`Token request failed: ${message}`);
  }

  return data.access_token;
}


// ── Webhook Registration (STUB) ─────────────────────────────────────────────

/**
 * Register this app's webhook URL with M360.
 * STUB — endpoint TBC with David Wood.
 *
 * TODO: Replace with David's confirmed endpoint once POC is complete.
 * POST https://app.marketing360.com/api/[endpoint-tbc]
 * Body: { account_id, webhook_url, platform: 'shopify' }
 *
 * @param {object} session
 * @param {string} accountId
 */
export async function registerWebhook(session, accountId) {
  // Build the shop-scoped webhook URL so the receiver route
  // (/webhooks/cmpro-blog/:shop) can identify the session on inbound requests.
  const appUrl     = process.env.SHOPIFY_APP_URL || '';
  const webhookUrl = `${appUrl}/webhooks/cmpro-blog/${encodeURIComponent(session.shop)}`;

  await cmproLog(
    session,
    `Webhook registration stub — URL would be: ${webhookUrl} — endpoint pending David.`,
    'warning'
  );
  // TODO: implement once David's endpoint is confirmed:
  // const token = await getToken(session);
  // await fetch('https://app.marketing360.com/api/[endpoint-tbc]', {
  //   method:  'POST',
  //   headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  //   body:    JSON.stringify({ account_id: accountId, webhook_url: webhookUrl, platform: 'shopify' }),
  // });
}


// ── Disconnect ──────────────────────────────────────────────────────────────

/**
 * Clear all stored credentials from session storage.
 *
 * @param {object} session
 */
export async function clearCredentials(session) {
  await setSessionData(session, null);
}
