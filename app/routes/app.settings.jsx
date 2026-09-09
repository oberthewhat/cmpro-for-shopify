import { useLoaderData, useFetcher, useNavigate } from 'react-router';
import { useState, useEffect } from 'react';
import {
  Page, Layout, Card, Text, Button, Banner, BlockStack,
  InlineStack, Badge, DataTable, TextField, Divider,
} from '@shopify/polaris';

export const loader = async ({ request }) => {
  const { authenticate } = await import('../shopify.server.js');
  const { getSessionData } = await import('../session.server.js');
  const { session } = await authenticate.admin(request);
  const data = await getSessionData(session);
  const url = new URL(request.url);
  const webhookUrl = `${url.protocol}//${url.host}/webhooks/cmpro-blog/${encodeURIComponent(session.shop)}`;
  return {
    connected:   !!data?.account_id,
    accountId:   data?.account_id   || null,
    accountName: data?.account_name || null,
    webhookUrl,
    blogCount:   data?.blog_count   || 0,
  };
};

export const action = async ({ request }) => {
  const { authenticate } = await import('../shopify.server.js');
  const { login, getAccounts, connectAccount, registerWebhook, unregisterWebhook, clearCredentials } = await import('../auth.server.js');
  const { setSessionData } = await import('../session.server.js');
  const { runReconciliation } = await import('../reconciliation.server.js');
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent   = formData.get('intent');

  if (intent === 'sign_in') {
    try {
      const auth     = await login(formData.get('username'), formData.get('password'));
      const accounts = await getAccounts(auth.access_token);
      // Persist tokens immediately so registration/reconciliation can
      // authenticate and refresh without re-entering the password —
      // mirrors the WP rest_sign_in behaviour.
      await setSessionData(session, {
        access_token:  auth.access_token,
        refresh_token: auth.refresh_token,
        token_expiry:  Date.now() + (auth.expires_in * 1000),
      });
      return { ok: true, accounts };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (intent === 'connect') {
    try {
      // Carry forward the tokens captured during sign_in so connect
      // doesn't overwrite them with a 'pending' placeholder.
      const { getSessionData } = await import('../session.server.js');
      const existing = await getSessionData(session);
      await connectAccount(session, {
        accountId:    formData.get('account_id'),
        accountName:  formData.get('account_name'),
        clientId:     formData.get('client_id')     || '',
        clientSecret: formData.get('client_secret') || '',
        accessToken:  existing?.access_token && existing.access_token !== 'pending' ? existing.access_token : undefined,
        refreshToken: existing?.refresh_token || undefined,
        expiresIn:    existing?.token_expiry ? Math.max(0, Math.floor((existing.token_expiry - Date.now()) / 1000)) : undefined,
      });
      return { ok: true, connected: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (intent === 'register_webhook') {
    try {
      const { getSessionData } = await import('../session.server.js');
      const cfg = await getSessionData(session);
      const accountNumber = cfg?.account_id || '';
      if (!accountNumber) {
        return { ok: false, error: 'No account connected. Complete setup first.' };
      }
      const result = await registerWebhook(session, accountNumber);
      return { ok: true, registered: true, webhookId: result.webhookId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (intent === 'unregister_webhook') {
    try {
      const { getSessionData } = await import('../session.server.js');
      const cfg = await getSessionData(session);
      const accountNumber = cfg?.account_id || '';
      if (!accountNumber) {
        return { ok: false, error: 'No account connected.' };
      }
      await unregisterWebhook(session, accountNumber);
      return { ok: true, unregistered: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (intent === 'disconnect') {
    await clearCredentials(session);
    return { ok: true, disconnected: true };
  }

  if (intent === 'manual_sync') {
    await runReconciliation(admin.graphql, session);
    return { ok: true, synced: true };
  }

  return { ok: false, error: 'Unknown intent' };
};

export default function SettingsPage() {
  const loaderData                      = useLoaderData();
  const { connected, accountId, accountName, webhookUrl, blogCount } = loaderData;
  const fetcher                         = useFetcher();
  const [showModal, setShowModal]       = useState(false);
  const [step, setStep]                 = useState('credentials');
  const [accounts, setAccounts]         = useState([]);
  const [username, setUsername]         = useState('');
  const [password, setPassword]         = useState('');
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  const isSubmitting = fetcher.state === 'submitting';
  const fetcherData = fetcher.data;

  useEffect(() => {
    if (!fetcherData) return;
    if (fetcherData.accounts) {
      setStep('accounts');
      setAccounts(fetcherData.accounts);
      setLoading(false);
    }
    if (fetcherData.error) {
      setError(fetcherData.error);
      setLoading(false);
    }
    if (fetcherData.registered) {
      setError('');
      window.alert(`Webhook registered${fetcherData.webhookId ? ` (ID: ${fetcherData.webhookId})` : ''}.`);
    }
    if (fetcherData.unregistered) {
      setError('');
      window.alert('Webhook unregistered.');
    }
    if (fetcherData.disconnected || fetcherData.connected) {
      window.location.reload();
    }
  }, [fetcherData]);

  const handleSignIn = () => {
    if (!username || !password) { setError('Please enter your email and password.'); return; }
    setLoading(true);
    setError('');
    const fd = new FormData();
    fd.append('intent', 'sign_in');
    fd.append('username', username);
    fd.append('password', password);
    fetcher.submit(fd, { method: 'POST' });
  };

  const handleSelectAccount = (account) => {
    const fd = new FormData();
    fd.append('intent',        'connect');
    fd.append('account_id',    account.accountNumber || account.id);
    fd.append('account_name',  account.displayName   || account.name || account.accountNumber);
    fd.append('client_id',     account.client_id     || '');
    fd.append('client_secret', account.client_secret || '');
    fetcher.submit(fd, { method: 'POST' });
  };

  return (
    <Page title="CMPro for Shopify" subtitle="Blog distribution from M360 to your Shopify store">

      {connected ? (
        <Banner tone="success" title="Connected to M360">
          <Text as="p">Account: <strong>{accountName || accountId}</strong> · Blogs synced: <strong>{blogCount}</strong></Text>
        </Banner>
      ) : (
        <Banner tone="warning" title="Not connected">
          <Text as="p">Connect to M360 to start receiving CMPro blog content.</Text>
        </Banner>
      )}

      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {connected ? (
                <>
                  <Text variant="headingMd" as="h2">Connection Active</Text>
                  <DataTable
                    columnContentTypes={['text', 'text']}
                    headings={[]}
                    rows={[
                      ['Account',      accountName || accountId],
                      ['Account ID',   accountId],
                      ['Webhook URL',  webhookUrl],
                      ['Blogs synced', `${blogCount} articles`],
                    ]}
                  />
                  <Divider />
                  <InlineStack gap="300">
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="register_webhook" />
                      <Button submit loading={isSubmitting} variant="secondary">Register Webhook</Button>
                    </fetcher.Form>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="unregister_webhook" />
                      <Button submit loading={isSubmitting} variant="secondary">Unregister Webhook</Button>
                    </fetcher.Form>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="manual_sync" />
                      <Button submit loading={isSubmitting} variant="secondary">Run Manual Sync</Button>
                    </fetcher.Form>
                    <fetcher.Form method="POST">
                      <input type="hidden" name="intent" value="disconnect" />
                      <Button submit tone="critical" variant="plain">Disconnect</Button>
                    </fetcher.Form>
                  </InlineStack>
                </>
              ) : (
                <>
                  <Text variant="headingMd" as="h2">Connect to M360</Text>
                  <Text as="p" tone="subdued">Sign in with your M360 credentials to connect this store.</Text>
                  {!showModal && (
                    <Button variant="primary" onClick={() => setShowModal(true)}>Connect to M360</Button>
                  )}
                  {showModal && (
                    <BlockStack gap="400">
                      {error && <Banner tone="critical"><Text as="p">{error}</Text></Banner>}
                      {step === 'credentials' && (
                        <BlockStack gap="300">
                          <TextField label="M360 Email" type="email" value={username} onChange={setUsername} autoComplete="off" />
                          <TextField label="M360 Password" type="password" value={password} onChange={setPassword} autoComplete="off" />
                          <InlineStack gap="300">
                            <Button variant="primary" onClick={handleSignIn} loading={loading || isSubmitting}>Connect</Button>
                            <Button onClick={() => { setShowModal(false); setStep('credentials'); setError(''); }}>Cancel</Button>
                          </InlineStack>
                        </BlockStack>
                      )}
                      {step === 'accounts' && (
                        <BlockStack gap="300">
                          <Text as="p" tone="subdued">Select the account to connect to this store.</Text>
                          {accounts.map((account) => (
                            <Card key={account.accountNumber || account.id}>
                              <InlineStack align="space-between" blockAlign="center">
                                <BlockStack gap="100">
                                  <Text variant="headingSm" as="p">{account.displayName || account.name || account.accountNumber}</Text>
                                  <Text as="p" tone="subdued" variant="bodySm">Account: {account.externalAccountNumber || account.accountNumber}</Text>
                                </BlockStack>
                                <Button variant="primary" onClick={() => handleSelectAccount(account)} loading={isSubmitting}>Select</Button>
                              </InlineStack>
                            </Card>
                          ))}
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
