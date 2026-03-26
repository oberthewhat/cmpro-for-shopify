/**
 * app.sync-log.jsx
 *
 * Sync log viewer.
 * Mirrors admin/sync-log.php — shows all CMPro log entries with level badges,
 * timestamps, and a clear log action.
 */

import { json, redirect }             from '@remix-run/node';
import { useLoaderData, useFetcher }  from '@remix-run/react';
import {
  Page, Layout, Card, Text, BlockStack, DataTable,
  Badge, Button, InlineStack, EmptyState,
} from '@shopify/polaris';
import { authenticate }  from '../shopify.server.js';
import { getLog, clearLog } from '../lib/log.server.js';

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const logs = await getLog(session);
  return json({ logs });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get('intent') === 'clear_log') {
    await clearLog(session);
    return redirect('/app/sync-log');
  }

  return json({ ok: false });
};

const LEVEL_TONES = {
  info:    'info',
  warning: 'warning',
  error:   'critical',
};

export default function SyncLogPage() {
  const { logs }  = useLoaderData();
  const fetcher   = useFetcher();

  return (
    <Page
      title="Sync Log"
      subtitle="All CMPro blog delivery and reconciliation activity"
      backAction={{ content: 'Settings', url: '/app/settings' }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">

              <InlineStack align="space-between">
                <Text variant="headingMd" as="h2">
                  {logs.length} {logs.length === 1 ? 'entry' : 'entries'}
                </Text>
                {logs.length > 0 && (
                  <fetcher.Form method="POST">
                    <input type="hidden" name="intent" value="clear_log" />
                    <Button submit tone="critical" variant="plain">
                      Clear Log
                    </Button>
                  </fetcher.Form>
                )}
              </InlineStack>

              {logs.length === 0 ? (
                <EmptyState
                  heading="No log entries yet"
                  image=""
                >
                  <Text as="p">
                    Activity will appear here once CMPro starts delivering blog content.
                  </Text>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Time', 'Level', 'Message']}
                  rows={logs.map(log => [
                    new Date(log.time).toLocaleString(),
                    <Badge tone={LEVEL_TONES[log.level] || 'info'}>
                      {log.level.toUpperCase()}
                    </Badge>,
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
