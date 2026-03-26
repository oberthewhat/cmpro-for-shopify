import { vitePlugin as remix }    from '@remix-run/dev';
import { defineConfig }           from 'vite';
import tsconfigPaths              from 'vite-tsconfig-paths';

// @ts-check

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ['**/.*'],
      future: {
        v3_fetcherPersist:     true,
        v3_relativeSplatPath:  true,
        v3_throwAbortReason:   true,
        v3_singleFetch:        true,
        v3_lazyRouteDiscovery: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  server: {
    port: 3000,
    warmup: {
      clientFiles: ['./app/entry.client.jsx'],
    },
  },
  optimizeDeps: {
    include: ['@shopify/polaris/build/esm/styles.css'],
  },
});
