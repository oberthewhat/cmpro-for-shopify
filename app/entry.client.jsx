/**
 * entry.client.jsx
 * Remix client entry point. Hydrates the SSR output.
 * Standard Shopify CLI scaffold — no CMPro-specific logic here.
 */

import { RemixBrowser } from '@remix-run/react';
import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>,
  );
});
