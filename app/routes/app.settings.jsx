/**
 * app.settings.jsx
 *
 * Connection setup and configuration.
 * Mirrors admin/settings-page.php — same three-step connect flow,
 * same account selection UI, same disconnect/manual sync actions.
 *
 * Uses Shopify Polaris components (the Shopify equivalent of WP admin UI).
 */

import { json, redirect }             from '@remix-run/node';
import { useLoaderData, useFetcher }  from '@remix-run/react';
import { useState }                   from 'react';
import {
  Page, Layout, Card, Text, Button, Banner, BlockStack,
  InlineStack, Badge, DataTable, Modal, TextField,
  Select, Spinner, Divider,
} from '@shopify/polaris';
import { authenticate }         from '../shopify.server.js';
import { login, getAccounts, connectAccount, clearCredentials } from '../lib/auth.server.js';
import { runReconciliation }    from '../lib/reconciliation.server.js';
import { getSessionData }       from '../lib/session.server.js';
import { cmproLog }             from '../lib/log.server.js';


// ── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const data = await getSessionData(session);

  return json({
    connected:    !!data?.account_id,
    accountId:    data?.account_id    || null,
    accountName:  data?.account_name  || null,
    webhookUrl:   getWebhookUrl(request, session.shop),
    blogCount:    data?.blog_count    || 0,
  });
};


// ── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent   = formData.get('intent');

  // ── Sign in — Step 1 & 2 ────────────────────────────────────────────────
  if (intent === 'sign_in') {
    const username = formData.get('username');
    const password = formData.get('password');

    try {
      const token    = await login(username, password);
      const accounts = await getAccounts(token);
      return json({ ok: true, accounts });
    } catch (err) {
      return json({ ok: false, error: err.message }, { status: 401 });
    }
  }

  // ── Connect account — Step 3 ─────────────────────────────────────────────
  if (intent === 'connect') {
    const accountData = {
      accountId:    formData.get('account_id'),
      accountName:  formData.get('account_name'),
      clientId:     formData.get('client_id')     || '',
      clientSecret: formData.get('client_secret') || '',
    };

    try {
      await connectAccount(session, accountData);
      return json({ ok: true, connected: true });
    } catch (err) {
      return json({ ok: false, error: err.message }, { status: 500 });
    }
  }

  // ── Disconnect ───────────────────────────────────────────────────────────
  if (intent === 'disconnect') {
    await clearCredentials(session);
    return redirect('/app/settings?notice=Disconnected+from+M360+successfully.&type=success');
  }

  // ── Manual sync (reconciliation) ─────────────────────────────────────────
  if (intent === 'manual_sync') {
    await runReconciliation(admin.graphql, session);
    return redirect('/app/settings?notice=Manual+sync+complete.+Check+the+sync+log.&type=success');
  }

  return json({ ok: false, error: 'Unknown intent' }, { status: 400 });
};


// ── Component ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { connected, accountId, accountName, webhookUrl, blogCount } = useLoaderData();
  const fetcher = useFetcher();

  const [showModal, setShowModal]       = useState(false);
  const [step, setStep]                 = useState('credentials'); // 'credentials' | 'accounts'
  const [accounts, setAccounts]         = useState([]);
  const [username, setUsername]         = useState('');
  const [password, setPassword]         = useState('');
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  const isSubmitting = fetcher.state === 'submitting';

  // Handle sign-in form submit
  const handleSignIn = async () => {
    if (!username || !password) {
      setError('Please enter your email and password.');
      return;
    }
    setLoading(true);
    setError('');

    const fd = new FormData();
    fd.append('intent',   'sign_in');
    fd.append('username', username);
    fd.append('password', password);

    fetcher.submit(fd, { method: 'POST' });
  };

  // Handle account selection
  const handleSelectAccount = (account) => {
    const fd = new FormData();
    fd.append('intent',        'connect');
    fd.append('account_id',    account.accountNumber || account.id);
    fd.append('account_name',  account.displayName   || account.name || account.accountNumber);
    fd.append('client_id',     account.client_id     || '');
    fd.append('client_secret', account.client_secret || '');
    fetcher.submit(fd, { method: 'POST' });
  };

  // Watch fetcher data changes
  const fetcherData = fetcher.data;
  if (fetcherData?.accounts && step === 'credentials') {
    setStep('accounts');
    setAccounts(fetcherData.accounts);
    setLoading(false);
  }
  if (fetcherData?.connected && !connected) {
    setShowModal(false);
  }
  if (fetcherData?.error && loading) {
    setError(fetcherData.error);
    setLoading(false);
  }

  return (
    <Page title="CMPro for Shopify" subtitle="Blog distribution from M360 to your Shopify store">

      {/* ── Status Banner ─────────────────────────────────────────────────── */}
      {connected ? (
        <Banner tone="success" title="Connected to M360">
          <Text as="p">
            Account: <strong>{accountName || accountId}</strong>
            {' · '}
            Blogs synced: <strong>{blogCount}</strong>
          </Text>
        </Banner>
      ) : (
        <Banner tone="warning" title="Not connected">
          <Text as="p">Connect to M360 to start receiving CMPro blog content.</Text>
        </Banner>
      )}

      <Layout>

        {/* ── Connection Card ──────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">

              {connected ? (
                <>
                  <Text variant="headingMd" as="h2">Connection Active</Text>
                  <Text as="p" tone="subdued">
                    This store is connected to M360 and will receive CMPro blog content automatically.
                  </Text>

                  <DataTable
                    columnContentTypes={['text', 'text']}
                    headings={[]}
                    rows={[
                      ['Account',     accountName || accountId],
                      ['Account ID',  accountId],
                      ['Webhook URL', webhookUrl],
                      ['Blogs synced', `${blogCount} articles`],
                    ]}
                  />

                  <Divider />

                  <InlineStack gap="300">
                    {/* Manual sync */}
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="manual_sync" />
                      <Button submit loading={isSubmitting} variant="secondary">
                        Run Manual Sync
                      </Button>
                    </fetcher.Form>

                    {/* Disconnect */}
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="disconnect" />
                      <Button submit tone="critical" variant="plain">
                        Disconnect
                      </Button>
                    </fetcher.Form>
                  </InlineStack>
                </>
              ) : (
                <>
                  <Text variant="headingMd" as="h2">Connect to M360</Text>
                  <Text as="p" tone="subdued">
                    Sign in with your M360 credentials to connect this store to CMPro.
                  </Text>
                  <Button variant="primary" onClick={() => setShowModal(true)}>
                    Connect to M360
                  </Button>
                </>
              )}

            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>

      {/* ── Login Modal ───────────────────────────────────────────────────── */}
      <Modal
        open={showModal}
        onClose={() => { setShowModal(false); setStep('credentials'); setError(''); }}
        title={step === 'credentials' ? 'Connect to Marketing 360®' : 'Select Account'}
      >
        <Modal.Section>
          <BlockStack gap="400">

            {error && (
              <Banner tone="critical">
                <Text as="p">{error}</Text>
              </Banner>
            )}

            {step === 'credentials' && (
              <BlockStack gap="300">
                <TextField
                  label="M360 Email"
                  type="email"
                  value={username}
                  onChange={setUsername}
                  autoComplete="off"
                />
                <TextField
                  label="M360 Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  autoComplete="off"
                />
                <Button
                  variant="primary"
                  fullWidth
                  onClick={handleSignIn}
                  loading={loading || isSubmitting}
                >
                  Connect
                </Button>
              </BlockStack>
            )}

            {step === 'accounts' && (
              <BlockStack gap="300">
                <Text as="p" tone="subdued">Select the account to connect to this store.</Text>
                {accounts.map((account) => (
                  <Card key={account.accountNumber || account.id}>
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text variant="headingSm" as="p">
                          {account.displayName || account.name || account.accountNumber}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Account: {account.externalAccountNumber || account.accountNumber}
                        </Text>
                      </BlockStack>
                      <Button
                        variant="primary"
                        onClick={() => handleSelectAccount(account)}
                        loading={isSubmitting}
                      >
                        Select
                      </Button>
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            )}

          </BlockStack>
        </Modal.Section>
      </Modal>

    </Page>
  );
}


// ── Helper ───────────────────────────────────────────────────────────────────

function getWebhookUrl(request, shop) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}/webhooks/cmpro-blog/${encodeURIComponent(shop || '')}`;
}
