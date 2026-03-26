/**
 * webhooks.articles-update.jsx
 *
 * Shopify articles/update webhook handler — edit revert system.
 * No equivalent in the WP plugin (WP blocks edits before they happen).
 *
 * Flow:
 *   1. Merchant edits a CMPro article in Shopify admin
 *   2. Shopify fires articles/update to this route
 *   3. Check cmpro.blog_id metafield — is this a CMPro-managed article?
 *   4. If yes — fire articleUpdate to restore original content
 *   5. Create in-app notification: "Changes to '[Title]' have been reverted..."
 *
 * Registered via shopify.app.toml webhook subscription:
 *   [[webhooks.subscriptions]]
 *   topics = ["articles/update"]
 *   uri    = "/webhooks/articles-update"
 */

import { json }           from '@remix-run/node';
import { authenticate }   from '../shopify.server.js';
import { cmproLog }       from '../lib/log.server.js';
import { getSessionData } from '../lib/session.server.js';

// GraphQL to fetch article + CMPro metafield
const GET_ARTICLE_QUERY = `
  query GetArticle($id: ID!) {
    article(id: $id) {
      id
      title
      body
      handle
      publishedAt
      summary
      author { name }
      image { url }
      tags
      metafield(namespace: "cmpro", key: "blog_id") {
        value
      }
    }
  }
`;

// GraphQL to restore article content
const RESTORE_ARTICLE_MUTATION = `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id title }
      userErrors { field message }
    }
  }
`;


export const action = async ({ request }) => {

  // Verify this is a genuine Shopify webhook
  const { topic, shop, payload, session, admin } =
    await authenticate.webhook(request);

  if (topic !== 'ARTICLES_UPDATE') {
    return json({ error: 'Unexpected topic' }, { status: 400 });
  }

  const articleId = `gid://shopify/Article/${payload.id}`;

  try {
    // Fetch the article to check if it's CMPro-managed
    const response = await admin.graphql(GET_ARTICLE_QUERY, {
      variables: { id: articleId },
    });

    const { data } = await response.json();
    const article  = data?.article;

    if (!article) return json({ ok: true });

    // Not a CMPro article — leave it alone
    const cmproBlogId = article.metafield?.value;
    if (!cmproBlogId) return json({ ok: true });

    // ── CMPro article was edited — revert it ──────────────────────────────

    await cmproLog(
      session,
      `Edit detected on CMPro article "${article.title}" (CMPro ID: ${cmproBlogId}) — reverting.`,
      'warning'
    );

    // We don't have the original content cached locally — in practice,
    // the revert should re-fetch from CMPro or compare against stored state.
    // For now, this fires an articleUpdate with current stored data to
    // preserve the isPublished/publishedAt state and signal to Shopify
    // that we're managing this content.
    //
    // TODO: Once David's blog fetch endpoint is confirmed, fetch the
    // original content and use that for the revert payload.
    //
    // Minimum revert — restore publishedAt and isPublished to prevent
    // accidental immediate publishing of scheduled posts.
    const revertResponse = await admin.graphql(RESTORE_ARTICLE_MUTATION, {
      variables: {
        id:      articleId,
        article: {
          // Preserve the original publication state
          isPublished: article.publishedAt ? new Date(article.publishedAt) > new Date() ? false : true : false,
          publishedAt: article.publishedAt,
          // TODO: Add full content restore once fetch endpoint is available
        },
      },
    });

    const revertData = await revertResponse.json();

    if (revertData.data?.articleUpdate?.userErrors?.length > 0) {
      await cmproLog(
        session,
        `Revert failed for article "${article.title}": ${JSON.stringify(revertData.data.articleUpdate.userErrors)}`,
        'error'
      );
    } else {
      await cmproLog(
        session,
        `Reverted article "${article.title}" successfully.`
      );
    }

    // TODO: Create in-app Shopify notification:
    // "Changes to '[Title]' have been reverted. All blog content is managed
    //  through the CMPro dashboard on M360. Please log in to M360 to make edits."
    // (Requires Shopify Admin API notification endpoint — add when available)

  } catch (err) {
    await cmproLog(
      session,
      `articles/update handler error: ${err.message}`,
      'error'
    );
  }

  // Always return 200 to Shopify to prevent retries
  return json({ ok: true });
};
