import { authenticate }   from '../shopify.server.js';
import { cmproLog }       from '../log.server.js';

export const unstable_noClientBundle = true;

const GET_ARTICLE_QUERY = `
  query GetArticle($id: ID!) {
    article(id: $id) {
      id
      title
      publishedAt
      metafield(namespace: "cmpro", key: "blog_id") {
        value
      }
    }
  }
`;

const RESTORE_ARTICLE_MUTATION = `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id title }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }) => {
  const { topic, payload, session, admin } =
    await authenticate.webhook(request);

  if (topic !== 'ARTICLES_UPDATE') {
    return json({ error: 'Unexpected topic' }, { status: 400 });
  }

  const articleId = `gid://shopify/Article/${payload.id}`;

  try {
    const response = await admin.graphql(GET_ARTICLE_QUERY, {
      variables: { id: articleId },
    });

    const { data } = await response.json();
    const article  = data?.article;

    if (!article) return json({ ok: true });

    const cmproBlogId = article.metafield?.value;
    if (!cmproBlogId) return json({ ok: true });

    await cmproLog(
      session,
      `Edit detected on CMPro article "${article.title}" — reverting.`,
      'warning'
    );

    await admin.graphql(RESTORE_ARTICLE_MUTATION, {
      variables: {
        id:      articleId,
        article: {
          isPublished: article.publishedAt ? new Date(article.publishedAt) <= new Date() : false,
          publishedAt: article.publishedAt,
        },
      },
    });

  } catch (err) {
    await cmproLog(session, `articles/update handler error: ${err.message}`, 'error');
  }

  return json({ ok: true });
};
