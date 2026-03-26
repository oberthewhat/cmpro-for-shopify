/**
 * app.jsx
 *
 * Nested layout for all /app/* routes (settings, dashboard, sync-log).
 * Wraps the Polaris AppProvider with Shopify App Bridge context,
 * and renders the top navigation.
 *
 * Equivalent to the WP plugin's admin menu registration in class-settings.php.
 */

import { Outlet, useLoaderData, useRouteError } from '@remix-run/react';
import { boundary }   from '@shopify/shopify-app-remix/server';
import { AppProvider } from '@shopify/shopify-app-remix/react';
import { NavMenu }    from '@shopify/app-bridge-react';
import polarisStyles  from '@shopify/polaris/build/esm/styles.css?url';
import { json }       from '@remix-run/node';
import { authenticate } from '../shopify.server.js';

export const links = () => [
  { rel: 'stylesheet', href: polarisStyles },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({ apiKey: process.env.SHOPIFY_API_KEY || '' });
};

export default function AppLayout() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>

      {/* Top navigation — equivalent to add_menu_page / add_submenu_page in WP */}
      <NavMenu>
        <a href="/app" rel="home">Dashboard</a>
        <a href="/app/settings">Settings</a>
        <a href="/app/sync-log">Sync Log</a>
      </NavMenu>

      <Outlet />

    </AppProvider>
  );
}

// Shopify-required error boundary for embedded app context
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
