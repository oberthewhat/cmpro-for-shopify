/**
 * app._index.jsx
 *
 * Main dashboard — sync status and article count.
 * Mirrors the CMPro for WordPress admin overview page.
 */

import { json }                  from '@remix-run/node';
import { useLoaderData, Link }   from '@remix-run/react';
import {
  Page, Layout, Card, Text, BlockStack,
  InlineStack, Badge, Button, DataTable,
} from '@shopify/polaris';
import { authenticate }    from '../shopify.server.js';
import { getSessionData }  from '../lib/session.server.js';
import { getLog }          from '../lib/log.server.js';

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const data        = await getSessionData(session);
  const recentLogs  = (await getLog(session)).slice(0, 5);

  return json({
    connected:   !!data?.account_id,
    accountName: data?.account_name || null,
    blogCount:   data?.blog_count   || 0,
    recentLogs,
  });
};

export default function Index() {
  const { connected, accountName, blogCount, recentLogs } = useLoaderData();

  return (
    <Page title="CMPro" subtitle="Blog distribution from M360">
      <Layout>

        {/* ── Status Card ─────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Connection Status</Text>
                <Badge tone={connected ? 'success' : 'warning'}>
                  {connected ? 'Connected' : 'Not Connected'}
                </Badge>
              </InlineStack>
              {connected ? (
                <Text as="p">Account: <strong>{accountName}</strong></Text>
              ) : (
                <Button variant="primary" url="/app/settings">Connect to M360</Button>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Blog Count Card ──────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">Articles Synced</Text>
              <Text variant="heading2xl" as="p">{blogCount}</Text>
              <Text as="p" tone="subdued">CMPro articles published to this store</Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Recent Log ───────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">Recent Activity</Text>
                <Button variant="plain" url="/app/sync-log">View full log →</Button>
              </InlineStack>
              {recentLogs.length === 0 ? (
                <Text as="p" tone="subdued">No activity yet.</Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Time', 'Level', 'Message']}
                  rows={recentLogs.map(log => [
                    new Date(log.time).toLocaleString(),
                    log.level.toUpperCase(),
                    log.message,
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}
