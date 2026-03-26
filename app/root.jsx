/**
 * root.jsx
 *
 * Root Remix layout. Sets up:
 *   - Shopify App Bridge (embedded app context)
 *   - Polaris provider (design system)
 *   - Global error boundary
 *
 * Standard Shopify CLI scaffold with CMPro branding applied.
 */

import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from '@remix-run/react';
import { json }         from '@remix-run/node';
import { authenticate } from './shopify.server.js';
import polarisStyles    from '@shopify/polaris/build/esm/styles.css?url';

export const links = () => [
  { rel: 'stylesheet', href: polarisStyles },
];

// The root loader just ensures the session is valid.
// All page-level data loading is in individual route loaders.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return json({});
};

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
        <title>Error — CMPro</title>
      </head>
      <body>
        <div style={{ padding: '40px', fontFamily: 'sans-serif' }}>
          <h1 style={{ color: '#c0392b' }}>CMPro encountered an error</h1>
          <p>
            Something went wrong. Please refresh the page or contact{' '}
            <a href="https://app.marketing360.com">M360 support</a>.
          </p>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
