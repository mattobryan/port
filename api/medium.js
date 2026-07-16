// Proxies the Medium RSS feed to JSON so the front-end can list articles
// without CORS issues. No credentials needed; cached at the edge for an hour,
// so the Writing view stays fresh automatically as new posts publish.

const FEED_URL = process.env.MEDIUM_FEED || 'https://medium.com/feed/@MatokeBryan';
const MAX_ARTICLES = 8;

function decodeXmlEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m, e) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'",
  }[e]));
}

function pick(block, tag) {
  const cdata = block.match(new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></' + tag + '>'));
  if (cdata) return cdata[1].trim();
  const plain = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  // Non-CDATA XML fields still carry entity-escaped text (e.g. &amp;) — decode
  // it here so index.html's esc() only ever escapes real HTML once, not twice.
  return plain ? decodeXmlEntities(plain[1].trim()) : '';
}

module.exports = async (req, res) => {
  try {
    const feedRes = await fetch(FEED_URL, { headers: { 'User-Agent': 'brian-matoke-portfolio' } });
    if (!feedRes.ok) throw new Error(`feed -> ${feedRes.status}`);
    const xml = await feedRes.text();

    const articles = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && articles.length < MAX_ARTICLES) {
      const block = m[1];
      const title = pick(block, 'title');
      const link = pick(block, 'link').split('?')[0];
      const pubDate = pick(block, 'pubDate');
      if (!title || !link) continue;
      articles.push({
        title,
        url: link,
        date: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : null,
      });
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ articles, source: FEED_URL.replace('/feed/', '/') });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(502).json({ articles: [], error: e.message });
  }
};
