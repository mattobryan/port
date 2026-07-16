const crypto = require('crypto');

const GITHUB_API = 'https://api.github.com';
const PORTFOLIO_OWNER = process.env.GITHUB_OWNER || 'mattobryan';
const PORTFOLIO_REPO = process.env.GITHUB_REPO || 'port';
const SCAN_OWNER = process.env.GITHUB_SCAN_OWNER || PORTFOLIO_OWNER;
const BRANCH = process.env.GITHUB_BRANCH || 'main';

const LANGUAGE_COLORS = {
  Python: '#3572A5', JavaScript: '#F1E05A', TypeScript: '#3178C6', Kotlin: '#A97BFF',
  HTML: '#E34C26', CSS: '#563D7C', Java: '#B07219', Go: '#00ADD8', Rust: '#DEA584',
  'C++': '#F34B7D', C: '#555555', Ruby: '#701516', Shell: '#89E051', Swift: '#F05138',
  Dart: '#00B4AB', PHP: '#4F5D95',
};

function ghHeaders() {
  const token = process.env.PORTFOLIO_GITHUB_TOKEN;
  if (!token) throw new Error('PORTFOLIO_GITHUB_TOKEN is not set');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'brian-matoke-portfolio-bot',
  };
}

async function ghJson(path, opts) {
  const res = await fetch(`${GITHUB_API}${path}`, { ...opts, headers: { ...ghHeaders(), ...(opts && opts.headers) } });
  if (!res.ok) {
    const err = new Error(`GitHub API ${path} -> ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function listAllRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await ghJson(`/users/${SCAN_OWNER}/repos?per_page=100&page=${page}&type=owner`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  // Private repos only show up via the authenticated /user/repos endpoint.
  try {
    for (let page = 1; page <= 5; page++) {
      const batch = await ghJson(`/user/repos?per_page=100&page=${page}&affiliation=owner`);
      batch.forEach((r) => { if (!repos.find((x) => x.full_name === r.full_name)) repos.push(r); });
      if (batch.length < 100) break;
    }
  } catch (e) {
    // Token may be scoped to public repos only; that's fine, we just miss private-repo detection.
  }
  return repos.filter((r) => !r.fork && r.full_name !== `${PORTFOLIO_OWNER}/${PORTFOLIO_REPO}`);
}

async function getRepoLanguages(fullName) {
  return ghJson(`/repos/${fullName}/languages`);
}

async function getReadme(fullName) {
  try {
    const data = await ghJson(`/repos/${fullName}/readme`);
    return Buffer.from(data.content, 'base64').toString('utf8').slice(0, 4000);
  } catch (e) {
    return '';
  }
}

// Returns { json: null, sha: null } only when the file genuinely doesn't exist (404).
// Any other failure (rate limit, 5xx, network) re-throws, so callers never mistake
// "GitHub had a hiccup" for "this file has never been created" — the two need very
// different handling (the former should abort, the latter should default to empty).
async function getFile(path) {
  try {
    const data = await ghJson(`/repos/${PORTFOLIO_OWNER}/${PORTFOLIO_REPO}/contents/${path}?ref=${BRANCH}`);
    return { json: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')), sha: data.sha };
  } catch (e) {
    if (e.status === 404) return { json: null, sha: null };
    throw e;
  }
}

async function putFile(path, json, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  return ghJson(`/repos/${PORTFOLIO_OWNER}/${PORTFOLIO_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function aggregateLanguages(reposWithLangs) {
  const totals = {};
  reposWithLangs.forEach(({ languages }) => {
    Object.entries(languages).forEach(([lang, bytes]) => {
      totals[lang] = (totals[lang] || 0) + bytes;
    });
  });
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5);
  const restBytes = sorted.slice(5).reduce((sum, [, bytes]) => sum + bytes, 0);
  const stats = top.map(([name, bytes]) => ({
    name,
    pct: Math.round((bytes / grandTotal) * 1000) / 10,
    color: LANGUAGE_COLORS[name] || '#9CA3AF',
  }));
  if (restBytes > 0) {
    stats.push({ name: 'Other', pct: Math.round((restBytes / grandTotal) * 1000) / 10, color: '#9CA3AF' });
  }
  return stats;
}

// --- Signed, stateless approval tokens ---

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(payload) {
  const secret = process.env.APPROVAL_SECRET;
  if (!secret) throw new Error('APPROVAL_SECRET is not set');
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const secret = process.env.APPROVAL_SECRET;
  if (!secret) throw new Error('APPROVAL_SECRET is not set');
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) throw new Error('Malformed token');
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad signature');
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (payload.exp && Date.now() > payload.exp) throw new Error('Token expired');
  return payload;
}

async function draftProjectCopy({ repo, description, readme, language, styleExamples }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const prompt = `You are drafting a portfolio project card in a specific voice. Here are existing examples of the style (problem/approach/outcome, one clause each, no fluff):

${styleExamples}

Now draft a card for this new repository. Output ONLY a JSON object with keys: summary (1 sentence), problem (one clause, lowercase start, no "The problem:" prefix), approach (one clause), outcome (one clause), stack (comma-separated tech list, inferred from language/README).

Repo: ${repo}
Description: ${description || '(none provided)'}
Primary language: ${language || 'unknown'}
README excerpt:
${readme || '(no README found)'}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API -> ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse drafted copy as JSON: ' + text);
  return JSON.parse(match[0]);
}

async function sendEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const dest = to || process.env.OWNER_EMAIL;
  const from = process.env.EMAIL_FROM || 'Portfolio Bot <onboarding@resend.dev>';
  if (!apiKey || !dest) throw new Error('RESEND_API_KEY / OWNER_EMAIL not set');
  const body = { from, to: dest, subject, html };
  if (replyTo) body.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend API -> ${res.status} ${await res.text()}`);
  return res.json();
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = {
  PORTFOLIO_OWNER, PORTFOLIO_REPO, SCAN_OWNER, BRANCH,
  listAllRepos, getRepoLanguages, getReadme, getFile, putFile,
  aggregateLanguages, signToken, verifyToken, draftProjectCopy, sendEmail, slugify,
};
