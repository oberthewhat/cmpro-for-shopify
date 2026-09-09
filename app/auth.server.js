/**
 * auth.server.js
 *
 * M360 authentication + token management.
 * Ported from the WordPress plugin's class-auth.php (CMPRO_Auth) so the
 * Shopify app speaks the exact same protocol as the confirmed WP version.
 *
 * Flow:
 *   1. login(username, password)              → { access_token, refresh_token, expires_in }
 *   2. getAccounts(token)                      → list of M360 accounts
 *   3. connectAccount(session, account)        → saves creds + tokens
 *   4. registerWebhook(session, accountNumber) → POST to CMP Plugins API, stores signing secret
 *   5. getToken(session)                       → valid bearer, auto-refresh via refresh_token grant
 *
 * ── CONFIRMED VALUES (David Wood / Jake Meyer, Aug 19) ──
 *   LOGIN_CLIENT_ID : 'cmp_shopify' — public Keycloak client created by M360
 *                     Core in BOTH stage and prod (alongside 'cmp_wordpress').
 *   CMP_PLUGIN_ID   : 'decb2b7dca7d4fca956fec70da56898c' — the Shopify
 *                     integration's CMP registry ID (WP's is b4cdf699…).
 *   Both are overridable via CMPRO_LOGIN_CLIENT_ID / CMPRO_PLUGIN_ID env vars.
 *   Stage firewall allowlists the Nexcess server egress IP (209.126.24.176);
 *   note the Shopify app's own egress IP will differ and may need allowlisting
 *   for stage if calls are blocked.
 */

import { getSessionData, setSessionData } from './session.server.js';
import { cmproLog } from './log.server.js';

// ── Environment ─────────────────────────────────────────────────────────────
// Which M360 environment to talk to. Override via CMPRO_ENV env var
// ('stage' or 'production'). Defaults to stage for testing — same default
// as the WP plugin.
function env() {
  const e = process.env.CMPRO_ENV || 'stage';
  return e === 'stage' || e === 'production' ? e : 'stage';
}

// Environment-specific hosts — mirrors CMPRO_Auth::hosts().
const HOSTS = {
  stage: {
    auth:     'https://login.stage.marketing360.com/auth/realms/marketing360/protocol/openid-connect/token',
    accounts: 'https://stage.marketing360.com/api/accounts',
    cmp:      'https://cmp.stage.marketing360.com',
  },
  production: {
    auth:     'https://login.marketing360.com/auth/realms/marketing360/protocol/openid-connect/token',
    accounts: 'https://app.marketing360.com/api/accounts',
    cmp:      'https://cmp.marketing360.com',
  },
};

function authUrl()     { return HOSTS[env()].auth; }
function accountsUrl() { return HOSTS[env()].accounts; }
function cmpBaseUrl()  { return HOSTS[env()].cmp; }

// Client ID for the username/password (direct access) login.
// Confirmed by David Wood (Aug 19): M360 Core created public Keycloak
// clients `cmp_wordpress` and `cmp_shopify` in BOTH stage and prod.
const LOGIN_CLIENT_ID = process.env.CMPRO_LOGIN_CLIENT_ID || 'cmp_shopify';

// This plugin's CMP registry ID. Confirmed Shopify ID (Jake/David):
//   Shopify   - decb2b7dca7d4fca956fec70da56898c
//   WordPress - b4cdf699a57b487cb5a88ccc667f561a
// Not environment-specific.
const CMP_PLUGIN_ID = process.env.CMPRO_PLUGIN_ID || 'decb2b7dca7d4fca956fec70da56898c';

// Token expiry fallback when the server doesn't return expires_in.
const DEFAULT_EXPIRES_IN = 300; // seconds


// ── Step 1: Login with username + password ──────────────────────────────────

/**
 * Exchange M360 username/password for tokens (Keycloak direct-access grant).
 * Returns access + refresh tokens; mirrors CMPRO_Auth::login().
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number}>}
 * @throws {Error} on failure
 */
export async function login(username, password) {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id:  LOGIN_CLIENT_ID,
    username,
    password,
  });

  const res = await m360Fetch(authUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const message = data.error_description || data.error || 'Unknown error';
    throw new Error(`M360 authentication failed: ${message}`);
  }

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || '',
    expires_in:    Number.isFinite(data.expires_in) ? data.expires_in : DEFAULT_EXPIRES_IN,
  };
}


// ── Step 2: Fetch account list ──────────────────────────────────────────────

/**
 * Fetch all M360 accounts for the authenticated user.
 * Mirrors CMPRO_Auth::get_accounts(). Accounts are under a 'response' key.
 *
 * @param {string} token  Login access token
 * @returns {Promise<Array>}
 * @throws {Error} on failure
 */
export async function getAccounts(token) {
  const res = await m360Fetch(`${accountsUrl()}?limit=999`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to retrieve accounts. Status: ${res.status}`);
  }

  const data = await res.json().catch(() => ({}));
  return data.response || [];
}


// ── Step 3: Connect selected account ────────────────────────────────────────

/**
 * Persist account credentials + tokens for the current shop.
 * Mirrors the WP rest_connect + connect_account persistence.
 *
 * Webhook registration is NOT auto-triggered here (matches the WP plugin's
 * later design: it's a separate, on-demand action so it can be retried
 * without disconnecting). Call registerWebhook() explicitly.
 *
 * @param {object} session
 * @param {object} account  { accountId, accountName, clientId, clientSecret,
 *                            accessToken, refreshToken, expiresIn }
 */
export async function connectAccount(session, account) {
  const {
    accountId, accountName,
    clientId, clientSecret,
    accessToken, refreshToken, expiresIn,
  } = account;

  const patch = {
    account_id:    accountId,
    account_name:  accountName,
    client_id:     clientId     || '',
    client_secret: clientSecret || '',
  };

  // If the sign-in step already produced tokens, persist them so
  // registration/reconciliation can authenticate without re-login.
  if (accessToken) {
    patch.access_token = accessToken;
    patch.refresh_token = refreshToken || '';
    patch.token_expiry  = Date.now() + ((expiresIn || DEFAULT_EXPIRES_IN) * 1000);
  } else {
    // No token yet — mark connected with a short placeholder so the UI
    // reflects state. get_token() will demand a real reconnect when used.
    patch.access_token = 'pending';
    patch.token_expiry = Date.now() + (24 * 60 * 60 * 1000);
  }

  await setSessionData(session, patch);
  await cmproLog(session, `Connected to M360 account: ${accountName} (${accountId})`);
}


// ── Token Management ────────────────────────────────────────────────────────

/**
 * Get a valid access token, refreshing via the refresh_token grant if needed.
 * Mirrors CMPRO_Auth::get_token() — refresh-token based, NOT client_credentials.
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

  const { access_token, token_expiry, refresh_token } = data;

  // Still valid (30s safety margin) — reuse.
  if (access_token && access_token !== 'pending' && Date.now() < (token_expiry - 30000)) {
    return access_token;
  }

  // Expired/missing — refresh using the stored refresh token.
  if (!refresh_token) {
    throw new Error('CMPro session has expired. Please reconnect in the CMPro settings page.');
  }

  const refreshed = await refreshToken(refresh_token);

  await setSessionData(session, {
    ...data,
    access_token: refreshed.access_token,
    token_expiry: Date.now() + (refreshed.expires_in * 1000),
    // Keycloak may rotate the refresh token — store the new one if given.
    ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
  });

  return refreshed.access_token;
}


/**
 * Exchange a refresh token for a fresh access token.
 * grant_type=refresh_token against the same Keycloak client.
 * Mirrors CMPRO_Auth::refresh_token().
 *
 * @param {string} refresh_token
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number}>}
 * @throws {Error} on failure
 */
export async function refreshToken(refresh_token) {
  const res = await m360Fetch(authUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     LOGIN_CLIENT_ID,
      refresh_token,
    }).toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const message = data.error_description || data.error || 'Unknown error';
    throw new Error(`Token refresh failed: ${message}`);
  }

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || '',
    expires_in:    Number.isFinite(data.expires_in) ? data.expires_in : DEFAULT_EXPIRES_IN,
  };
}


/**
 * OAuth2 client_credentials grant — kept for parity with the WP plugin's
 * get_token_via_client_credentials(). Not used by getToken() (which is
 * refresh-token based), but available if a client-credentials flow is needed.
 *
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<string>} access token
 */
export async function getTokenViaClientCredentials(clientId, clientSecret) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await m360Fetch(authUrl(), {
    method:  'POST',
    headers: { Authorization: `Basic ${basicAuth}` },
    body:    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    const message = data.error_description || data.error || 'Unknown error';
    throw new Error(`Token request failed: ${message}`);
  }

  return data.access_token;
}


// ── Step 4: Webhook Registration ────────────────────────────────────────────

/**
 * Register this shop's webhook receiver URL with the M360 CMP Plugins API.
 * Ported from CMPRO_Auth::register_webhook().
 *
 *   POST {cmp_base}/v1/accounts/{accountNumber}/plugins/{pluginId}
 *   Body: { "url": "<our receiver URL>" }
 *   Auth: Bearer token (must carry the cmp_manage permission)
 *
 * On 201 the response returns the signing secret exactly once under
 * data.secret — we MUST persist it. It cannot be recovered later; losing it
 * means unregister + re-register.
 *
 * The receiver URL must already be live and answering the GET confirm
 * handshake BEFORE this call — M360 verifies it synchronously.
 *
 * @param {object} session
 * @param {string} accountNumber  M360 account number (path segment)
 * @returns {Promise<{webhookId:string, installId:string}>}
 * @throws {Error} on failure
 */
export async function registerWebhook(session, accountNumber) {
  if (!accountNumber) {
    throw new Error('No M360 account number available. Connect an account first.');
  }

  const bearer = await getToken(session);
  if (!bearer || bearer === 'pending') {
    throw new Error('No usable bearer token. Complete account connection first.');
  }

  // The receiver URL M360 will call. Shop-scoped so the receiver route
  // (/webhooks/cmpro-blog/:shop) can resolve the session on inbound POSTs.
  const appUrl = process.env.SHOPIFY_APP_URL || '';
  const webhookUrl = `${appUrl}/webhooks/cmpro-blog/${encodeURIComponent(session.shop)}`;

  const endpoint = `${cmpBaseUrl()}/v1/accounts/${encodeURIComponent(accountNumber)}`
    + `/plugins/${encodeURIComponent(CMP_PLUGIN_ID)}`;

  const res = await m360Fetch(endpoint, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: webhookUrl }),
  });

  const code = res.status;
  const body = await res.json().catch(() => ({}));

  // ── Success ──
  if (code === 201) {
    const data   = body.data || {};
    const secret = data.secret || '';

    if (!secret) {
      await cmproLog(session, 'Registration returned 201 but no secret in response — must unregister and retry.', 'error');
      throw new Error('Registration succeeded but no signing secret was returned. Unregister and try again.');
    }

    await setSessionData(session, {
      ...(await getSessionData(session)),
      webhook_secret: secret,
      webhook_id:     data.webhookId || '',
      install_id:     data.id || '',
    });

    await cmproLog(session, `Webhook registered. Install ID: ${data.id || 'n/a'}, webhook ID: ${data.webhookId || 'n/a'}`);
    return { webhookId: data.webhookId || '', installId: data.id || '' };
  }

  // ── Error handling — keyed to the CMP Plugins API error codes ──
  // (see openapi-plugins.yaml: registerPlugin responses)
  const errCode = body?.error?.code    || 'UNKNOWN';
  const errMsg  = body?.error?.message || 'Unknown error';
  const context = body?.error?.context || {};

  // 400 — destination URL failed the confirm handshake. context.code is one of
  // INVALID_STATUS_CODE | INVALID_CONTENT_TYPE | INVALID_CONFIRMATION.
  if (errCode === 'WEBHOOK_VERIFICATION_FAILED') {
    const detail = context.code || 'unspecified';
    await cmproLog(session, `Webhook verification handshake failed (${detail}). Is the GET confirm handler live at ${webhookUrl}? Detail: ${JSON.stringify(context)}`, 'error');
    throw new Error(`Endpoint verification failed: ${detail}. Confirm the receiver URL is publicly reachable and echoes the ?confirm token as text/plain.`);
  }

  // 409 — three distinct conflicts, each needs a different fix.
  if (code === 409) {
    if (errCode === 'PLUGIN_ALREADY_REGISTERED') {
      await cmproLog(session, 'Plugin already registered for this account — unregister first, then re-register.', 'error');
      throw new Error('This plugin is already registered for the account. Unregister it first (Disconnect Webhook), then register again.');
    }
    if (errCode === 'WEBHOOK_URL_REGISTERED') {
      await cmproLog(session, `Destination URL already subscribed for this account: ${webhookUrl}`, 'error');
      throw new Error('This destination URL is already subscribed for the account. Unregister the existing subscription first (e.g. if the ngrok URL changed).');
    }
    if (errCode === 'PLUGIN_DISABLED') {
      await cmproLog(session, 'Plugin is flagged as disabled in the CMP registry.', 'error');
      throw new Error('The Shopify plugin is flagged as disabled in the CMP registry. Flag to David/Jake.');
    }
    await cmproLog(session, `Registration conflict (${errCode}): ${errMsg}`, 'error');
    throw new Error(`${errMsg} (${errCode})`);
  }

  // 404 — unknown pluginId (not in registry) vs account/route not found.
  if (code === 404) {
    if (errCode === 'PLUGIN_NOT_FOUND') {
      await cmproLog(session, `PLUGIN_NOT_FOUND — pluginId ${CMP_PLUGIN_ID} is not in the CMP registry for this environment (${env()}).`, 'error');
      throw new Error(`Plugin ID not found in the CMP registry (env: ${env()}). Verify CMP_PLUGIN_ID and that you're pointed at the right environment.`);
    }
    await cmproLog(session, `Registration 404 (${errCode}): ${errMsg}. Check the account number in the URL path.`, 'error');
    throw new Error(`${errMsg} (HTTP 404) — verify the account number "${accountNumber}" is correct for the path.`);
  }

  // 403 — token lacks cmp_manage.
  if (code === 403) {
    await cmproLog(session, 'Registration forbidden (403) — token likely missing cmp_manage permission.', 'error');
    throw new Error('Registration forbidden — the token may be missing the cmp_manage permission. Flag to Jake.');
  }

  // 401 — missing/invalid bearer.
  if (code === 401) {
    await cmproLog(session, 'Registration unauthorized (401) — bearer token missing or invalid. Try reconnecting.', 'error');
    throw new Error('Unauthorized (401) — the bearer token is missing or invalid. Reconnect the account and try again.');
  }

  // 500 — REGISTER_WEBHOOK_FAILED | REGISTER_PLUGIN_FAILED (subscription rolled back).
  await cmproLog(session, `Webhook registration failed [${code} ${errCode}]: ${errMsg}`, 'error');
  throw new Error(`${errMsg} (HTTP ${code}${errCode !== 'UNKNOWN' ? ' ' + errCode : ''})`);
}


// ── Unregister webhook ──────────────────────────────────────────────────────

/**
 * Unregister this plugin for the account.
 *   DELETE {cmp_base}/v1/accounts/{accountNumber}/plugins/{pluginId}
 *   Auth: Bearer with cmp_manage. Success: 204 (no body).
 *
 * Needed to clear a stale registration before re-registering — e.g. when the
 * ngrok destination URL changes (WEBHOOK_URL_REGISTERED) or the plugin is
 * already registered (PLUGIN_ALREADY_REGISTERED). Per the spec, a subscription
 * that no longer exists upstream is tolerated, so this is safe to retry.
 *
 * @param {object} session
 * @param {string} accountNumber
 * @returns {Promise<boolean>} true on 204
 * @throws {Error} on failure
 */
export async function unregisterWebhook(session, accountNumber) {
  if (!accountNumber) {
    throw new Error('No M360 account number available.');
  }

  const bearer = await getToken(session);
  if (!bearer || bearer === 'pending') {
    throw new Error('No usable bearer token. Complete account connection first.');
  }

  const endpoint = `${cmpBaseUrl()}/v1/accounts/${encodeURIComponent(accountNumber)}`
    + `/plugins/${encodeURIComponent(CMP_PLUGIN_ID)}`;

  const res = await m360Fetch(endpoint, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${bearer}` },
  });

  if (res.status === 204) {
    // Clear the now-invalid signing secret and IDs locally.
    await setSessionData(session, {
      ...(await getSessionData(session)),
      webhook_secret: null,
      webhook_id:     null,
      install_id:     null,
    });
    await cmproLog(session, 'Webhook unregistered.');
    return true;
  }

  const body    = await res.json().catch(() => ({}));
  const errCode = body?.error?.code    || 'UNKNOWN';
  const errMsg  = body?.error?.message || 'Unknown error';

  if (res.status === 404 && errCode === 'PLUGIN_NOT_REGISTERED') {
    // Already gone upstream — clear locally and treat as success.
    await setSessionData(session, {
      ...(await getSessionData(session)),
      webhook_secret: null,
      webhook_id:     null,
      install_id:     null,
    });
    await cmproLog(session, 'Plugin was not registered upstream — cleared local webhook state.', 'info');
    return true;
  }

  await cmproLog(session, `Webhook unregister failed [${res.status} ${errCode}]: ${errMsg}`, 'error');
  throw new Error(`${errMsg} (HTTP ${res.status})`);
}


// ── Disconnect ──────────────────────────────────────────────────────────────

/**
 * Clear all stored credentials from storage.
 * @param {object} session
 */
export async function clearCredentials(session) {
  await setSessionData(session, null);
}


// ── Internal HTTP helper ────────────────────────────────────────────────────

/**
 * Central fetch wrapper for M360 calls. Sends a browser-like User-Agent +
 * Accept so stage's edge (Varnish/WAF) doesn't 403 server-to-server calls —
 * mirrors the same workaround in the WP plugin's cmpro_request().
 */
async function m360Fetch(url, options = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept':     'application/json, text/plain, */*',
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}
