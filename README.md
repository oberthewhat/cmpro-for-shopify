# CMPro for Shopify

Shopify embedded app that receives CMPro blog content from M360 and publishes it to a Shopify store. Mirrors the architecture of the CMPro for WordPress plugin.

---

## Prerequisites

- Node.js 18.20+
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm install -g @shopify/cli`)
- A [Shopify Partners](https://partners.shopify.com) account
- A Shopify development store

---

## Local Dev Setup

### 1. Clone and install

```bash
git clone <repo>
cd cmpro-shopify-app
npm install
```

### 2. Create a Shopify app in Partners dashboard

1. Go to [partners.shopify.com](https://partners.shopify.com) → Apps → Create app
2. Choose **Build app with Shopify CLI**
3. Copy the **API key** and **API secret**

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:
- `SHOPIFY_API_KEY` — from Partners dashboard
- `SHOPIFY_API_SECRET` — from Partners dashboard
- `SHOPIFY_APP_URL` — Shopify CLI will set this automatically during dev
- `DATABASE_URL` — leave as `file:./dev.db` for local dev

### 4. Set up the database

```bash
npx prisma migrate dev --name init
```

This creates `prisma/dev.db` (SQLite) and runs the migration.

### 5. Update shopify.app.toml

Replace the placeholders in `shopify.app.toml`:
```toml
client_id = "your_api_key_here"
application_url = "https://your-tunnel-url.trycloudflare.com"
```

Or let the CLI manage this — run `shopify app config link` to connect the toml to your Partners app automatically.

### 6. Start the dev server

```bash
npm run dev
```

Shopify CLI will:
- Start a Cloudflare tunnel to expose your local server
- Update `shopify.app.toml` with the tunnel URL
- Open the install URL for your dev store

### 7. Install on your dev store

Follow the URL printed by the CLI to install the app on your development store.

---

## Project Structure

```
cmpro-shopify-app/
├── app/
│   ├── lib/
│   │   ├── auth.server.js          # M360 auth — mirrors class-auth.php
│   │   ├── publisher.server.js     # Shopify GraphQL publish — mirrors class-publisher.php
│   │   ├── reconciliation.server.js # Fallback poll — mirrors class-reconciliation.php
│   │   ├── signature.server.js     # HMAC verification — mirrors class-webhook.php
│   │   ├── log.server.js           # Sync log — mirrors cmpro_log()
│   │   ├── session.server.js       # Per-shop config storage (Prisma)
│   │   └── db.server.js            # Prisma client singleton
│   ├── routes/
│   │   ├── app.jsx                 # Nested layout + nav
│   │   ├── app._index.jsx          # Dashboard
│   │   ├── app.settings.jsx        # Connection setup — mirrors settings-page.php
│   │   ├── app.sync-log.jsx        # Log viewer — mirrors sync-log.php
│   │   ├── app.reconciliation-cron.jsx  # Cron trigger endpoint
│   │   ├── webhooks.cmpro-blog.jsx      # CMPro webhook receiver
│   │   ├── webhooks.articles-update.jsx # Shopify revert handler
│   │   └── auth.$.jsx              # Shopify OAuth
│   ├── shopify.server.js           # Shopify app config + authenticate helper
│   ├── root.jsx                    # HTML shell
│   ├── entry.server.jsx            # SSR entry
│   └── entry.client.jsx            # Client hydration
├── prisma/
│   ├── schema.prisma               # DB schema (Session, CmproConfig, SyncLog)
│   └── migrations/
├── shopify.app.toml                # Shopify CLI app config
├── vite.config.js
├── vercel.json                     # Deployment + cron schedule
└── .env.example
```

---

## Architecture

Both the WordPress plugin and this app follow the same pattern:

| Concern | WordPress | Shopify |
|---|---|---|
| Content delivery | REST endpoint `/wp-json/cmpro/v1/webhook` | Remix route `/webhooks/cmpro-blog` |
| Signature verification | `hash_hmac('sha256', ...)` | `crypto.createHmac('sha256', ...)` |
| Publishing | `wp_insert_post()` | `articleCreate` GraphQL mutation |
| Deduplication | `_cmpro_id` post meta | `cmpro.blog_id` metafield |
| Scheduled posts | `post_status: 'future'` | `isPublished: false` + `publishedAt` |
| Reconciliation | WP-Cron every 6h | Vercel Cron every 6h |
| Edit prevention | CPT blocks editor UI | `articles/update` webhook + revert |
| Credentials | `wp_options` table | `CmproConfig` Prisma table |
| Sync log | `cmpro_sync_log` option | `SyncLog` Prisma table |

---

## Open Items (matches WP plugin)

The following are stubs pending confirmation from David Wood:

- **Webhook registration endpoint** — `registerWebhook()` in `auth.server.js`
- **Webhook payload schema** — field names TBC, parser in `publisher.server.js`
- **Signature verification spec** — exact header, algorithm, encoding; see `signature.server.js`
- **Webhook retry policy** — CMPro retry behaviour on failed delivery
- **Reconciliation list endpoint** — `fetchPublishedIds()` in `reconciliation.server.js`
- **Blog fetch endpoint** — `fetchBlog()` in `reconciliation.server.js`

All stubs log a `warning` entry and match the identical stubs in the WP plugin.

---

## Deployment (Vercel)

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard:
# SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL,
# DATABASE_URL (postgres://...), CRON_SECRET
```

The reconciliation cron runs automatically every 6 hours via `vercel.json`.
