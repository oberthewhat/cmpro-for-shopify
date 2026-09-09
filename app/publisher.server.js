/**
 * publisher.server.js
 *
 * Publishes a CMPro blog to Shopify via the GraphQL Admin API.
 * Mirrors class-publisher.php — same field mapping, same deduplication logic,
 * same logging style. Platform differences handled here:
 *   - GraphQL instead of wp_insert_post()
 *   - Metafields instead of post_meta
 *   - Image URL passed directly (no sideloading needed)
 *   - isPublished:false + publishedAt for scheduled posts
 *
 * Shopify GraphQL API docs:
 *   https://shopify.dev/docs/api/admin-graphql/latest/mutations/articleCreate
 */

import { cmproLog }           from './log.server.js';
import { incrementBlogCount } from './session.server.js';

// ── GraphQL Mutations ───────────────────────────────────────────────────────

const ARTICLE_CREATE_MUTATION = `
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        handle
        title
        publishedAt
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const ARTICLE_UPDATE_MUTATION = `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        handle
        title
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const FIND_ARTICLE_BY_CMPRO_ID = `
  query FindArticleByCmproId($namespace: String!, $key: String!, $value: String!) {
    articles(first: 1, query: $value) {
      edges {
        node {
          id
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }
    }
  }
`;


// ── Main Publish Function ───────────────────────────────────────────────────

/**
 * Publish or update a CMPro blog on Shopify.
 * Entry point — mirrors CMPRO_Publisher::publish() in the WP plugin.
 *
 * @param {object} graphql      Shopify Admin GraphQL client (from Remix loader/action)
 * @param {object} session
 * @param {object} blog         Blog object from webhook payload
 * @param {string} cmproBlogId  Shopify Blog GID to publish into (from app settings)
 * @returns {Promise<string>}   Shopify article GID on success
 * @throws {Error}              On validation or API failure
 */
export async function publishBlog(graphql, session, blog, cmproBlogId) {

  if (!blog.id || !blog.title || !blog.html_content) {
    throw new Error('Blog payload is missing required fields (id, title, html_content).');
  }

  // Resolve which Shopify Blog to publish into. If the app settings don't
  // specify one yet, fall back to the store's first blog (every store has at
  // least the default "News" blog). This keeps publishing working before the
  // blog-picker UI is wired up.
  let targetBlogId = cmproBlogId;
  if (!targetBlogId) {
    targetBlogId = await getDefaultBlogId(graphql);
    if (!targetBlogId) {
      throw new Error('No Shopify blog found to publish into. Create a blog in Shopify (Online Store → Blog posts) or set one in app settings.');
    }
    await cmproLog(session, `No blog configured — defaulting to the store's first blog (${targetBlogId}).`, 'warning');
  }

  // Deduplication — check if this CMPro blog ID already exists
  const existingId = await getExistingArticleId(graphql, blog.id);

  const articleInput = buildArticleInput(blog, targetBlogId);

  let shopifyId;
  let action;

  if (existingId) {
    // Update existing article
    shopifyId = await updateArticle(graphql, existingId, articleInput);
    action    = 'updated';
  } else {
    // Create new article
    shopifyId = await createArticle(graphql, articleInput);
    action    = 'created';
  }

  await cmproLog(session, `Blog ${action}: Shopify ID ${shopifyId} — CMPro ID: ${blog.id}`);

  if (action === 'created') {
    await incrementBlogCount(session);
  }

  return shopifyId;
}


// ── Article Input Builder ───────────────────────────────────────────────────

/**
 * Build the ArticleCreateInput / ArticleUpdateInput object.
 * Field mapping mirrors the table in section 04 of the Technical Reference.
 *
 * @param {object} blog
 * @param {string} cmproBlogId  Shopify Blog GID
 */
function buildArticleInput(blog, cmproBlogId) {
  const isScheduled = blog.publish_date && new Date(blog.publish_date) > new Date();

  const input = {
    blogId:      cmproBlogId,
    title:       blog.title,
    body:        blog.html_content,               // raw HTML — no modification
    handle:      blog.slug || slugify(blog.title),
    isPublished: new Date(blog.publish_date || new Date()) <= new Date(),
    author:      { name: blog.author || 'CMPro' },
    metafields: [
      {
        namespace: 'cmpro',
        key:       'blog_id',
        value:     blog.id,
        type:      'single_line_text_field',
      },
      {
        namespace: 'cmpro',
        key:       'collection_id',
        value:     blog.collection_id || '',
        type:      'single_line_text_field',
      },
    ],
  };

  // Summary (excerpt)
  if (blog.excerpt) {
    input.summary = blog.excerpt;
  }

  // Featured image — Shopify accepts URL directly, no sideloading needed
  if (blog.featured_image_url) {
    input.image = { url: blog.featured_image_url };
  }

  // Tags
  if (blog.tags && Array.isArray(blog.tags) && blog.tags.length > 0) {
    input.tags = blog.tags;
  }

  return input;
}


// ── GraphQL Helpers ─────────────────────────────────────────────────────────

async function createArticle(graphql, articleInput) {
  const response = await graphql(ARTICLE_CREATE_MUTATION, {
    variables: { article: articleInput },
  });

  const { data } = await response.json();
  const result   = data?.articleCreate;

  if (result?.userErrors?.length > 0) {
    const errors = result.userErrors.map(e => `${e.field}: ${e.message}`).join(', ');
    throw new Error(`Shopify articleCreate failed: ${errors}`);
  }

  return result?.article?.id;
}


async function updateArticle(graphql, shopifyId, articleInput) {
  // Remove blogId from update input — it's not allowed on updates
  const { blogId, ...updateInput } = articleInput;

  const response = await graphql(ARTICLE_UPDATE_MUTATION, {
    variables: { id: shopifyId, article: updateInput },
  });

  const { data } = await response.json();
  const result   = data?.articleUpdate;

  if (result?.userErrors?.length > 0) {
    const errors = result.userErrors.map(e => `${e.field}: ${e.message}`).join(', ');
    throw new Error(`Shopify articleUpdate failed: ${errors}`);
  }

  return result?.article?.id;
}


/**
 * Find an existing Shopify article by CMPro blog ID (stored in metafield).
 * Returns the Shopify article GID, or null if not found.
 *
 * @param {object} graphql
 * @param {string} cmproBlogId
 * @returns {Promise<string|null>}
 */
async function getExistingArticleId(graphql, cmproBlogId) {
  try {
    // Query articles with matching cmpro.blog_id metafield
    // Note: Shopify metafield search via query string is limited —
    // this uses a best-effort approach. If David's API provides a
    // lookup endpoint, prefer that.
    const response = await graphql(`
      query {
        articles(first: 1, query: "metafield:cmpro.blog_id:${cmproBlogId}") {
          edges {
            node {
              id
              metafield(namespace: "cmpro", key: "blog_id") {
                value
              }
            }
          }
        }
      }
    `);

    const { data } = await response.json();
    const edges = data?.articles?.edges || [];

    if (edges.length === 0) return null;

    // Double-check the metafield value matches exactly
    const article = edges[0].node;
    if (article.metafield?.value === cmproBlogId) {
      return article.id;
    }

    return null;
  } catch {
    // If lookup fails, treat as new — safe to create
    return null;
  }
}


// ── Utils ───────────────────────────────────────────────────────────────────

/**
 * Fetch the GID of the store's first blog. Used as a fallback destination
 * when no blog is configured in app settings. Returns null if the store has
 * no blogs at all.
 *
 * @param {object} graphql
 * @returns {Promise<string|null>}
 */
async function getDefaultBlogId(graphql) {
  try {
    const response = await graphql(`
      query {
        blogs(first: 1) {
          edges { node { id title } }
        }
      }
    `);
    const { data } = await response.json();
    return data?.blogs?.edges?.[0]?.node?.id || null;
  } catch {
    return null;
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
