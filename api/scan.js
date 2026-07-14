const {
  PORTFOLIO_OWNER, listAllRepos, getRepoLanguages, getReadme, getFile, putFile,
  aggregateLanguages, signToken, draftProjectCopy, sendEmail, slugify,
} = require('./_lib');

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_NEW_REPOS_PER_RUN = 5;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured yet -> allow (document this in SETUP.md)
  return req.headers.authorization === `Bearer ${secret}`;
}

function approveUrl(base, token) {
  return `${base}/api/approve?token=${encodeURIComponent(token)}`;
}

function draftEmailHtml({ candidates, langChanged, langStats, siteUrl }) {
  const cards = candidates.map((c) => `
    <div style="border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin-bottom:16px;">
      <h3 style="margin:0 0 8px;">${c.repo.full_name}${c.repo.private ? ' 🔒' : ''}</h3>
      <p style="color:#555;margin:0 0 8px;">${c.draft.summary}</p>
      <p style="font-size:13px;color:#555;line-height:1.6;">
        <b>Problem:</b> ${c.draft.problem} <b>Approach:</b> ${c.draft.approach} <b>Outcome:</b> ${c.draft.outcome}
      </p>
      <p style="font-size:12px;color:#888;">${c.draft.stack}</p>
      <p>
        <a href="${c.publishUrl}" style="background:#4F46E5;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;margin-right:10px;">Publish to portfolio</a>
        <a href="${c.skipUrl}" style="color:#888;text-decoration:underline;">Skip for now</a>
      </p>
    </div>`).join('');

  const langBlock = langChanged ? `
    <p style="font-size:13px;color:#555;">Language stats updated automatically (no approval needed): ${langStats.map((s) => `${s.name} ${s.pct}%`).join(', ')}.</p>` : '';

  return `
    <div style="font-family:sans-serif;max-width:560px;">
      <h2>Portfolio scan found ${candidates.length} new repo(s)</h2>
      ${cards}
      ${langBlock}
      <p style="font-size:12px;color:#999;">Sent by the portfolio's daily scan. <a href="${siteUrl}">View live site</a>.</p>
    </div>`;
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const siteUrl = process.env.SITE_URL || 'https://port-three-taupe.vercel.app';
  const log = { newRepos: [], langChanged: false, emailed: false, errors: [] };

  try {
    const [repos, known, projectsFile] = await Promise.all([
      listAllRepos(),
      getFile('data/known-repos.json'),
      getFile('data/projects.json'),
    ]);

    const knownJson = known.json || { repos: [] };
    const knownNames = new Set(knownJson.repos.map((r) => r.repo));

    // --- language stats: always safe to auto-update, no approval needed ---
    const withLangs = await Promise.all(repos.map(async (r) => ({
      repo: r, languages: await getRepoLanguages(r.full_name).catch(() => ({})),
    })));
    const stats = aggregateLanguages(withLangs);
    const prevStats = JSON.stringify((projectsFile.json && projectsFile.json.languages && projectsFile.json.languages.stats) || []);
    if (projectsFile.json && JSON.stringify(stats) !== prevStats) {
      projectsFile.json.languages.stats = stats;
      projectsFile.json.languages.repoCount = repos.length;
      projectsFile.json.languages.updatedAt = new Date().toISOString().slice(0, 10);
      await putFile('data/projects.json', projectsFile.json, projectsFile.sha, 'Auto-update language stats from GitHub scan');
      log.langChanged = true;
    }

    // --- new repo detection: needs human approval before publishing ---
    const newRepos = repos.filter((r) => !knownNames.has(r.full_name)).slice(0, MAX_NEW_REPOS_PER_RUN);
    const styleExamples = (projectsFile.json.projects || []).slice(0, 2).map((p) =>
      `Problem: ${p.problem} Approach: ${p.approach} Outcome: ${p.outcome}`).join('\n');

    const candidates = [];
    for (const repo of newRepos) {
      try {
        const readme = await getReadme(repo.full_name);
        const draft = await draftProjectCopy({
          repo: repo.full_name, description: repo.description, readme,
          language: repo.language, styleExamples,
        });
        const exp = Date.now() + TOKEN_TTL_MS;
        const projectRecord = {
          id: slugify(repo.name),
          name: repo.name,
          repo: repo.full_name,
          visibility: repo.private ? 'private' : 'public',
          demoUrl: !repo.private && repo.has_pages ? `https://${PORTFOLIO_OWNER}.github.io/${repo.name}/` : (repo.homepage || null),
          repoUrl: repo.private ? null : repo.html_url,
          ...draft,
        };
        const publishToken = signToken({ v: 1, action: 'publish', repo: repo.full_name, project: projectRecord, exp });
        const skipToken = signToken({ v: 1, action: 'skip', repo: repo.full_name, exp });
        candidates.push({
          repo, draft,
          publishUrl: approveUrl(siteUrl, publishToken),
          skipUrl: approveUrl(siteUrl, skipToken),
        });
        log.newRepos.push(repo.full_name);
      } catch (e) {
        log.errors.push(`${repo.full_name}: ${e.message}`);
      }
    }

    if (candidates.length) {
      await sendEmail({
        subject: `Portfolio: ${candidates.length} new project(s) to review`,
        html: draftEmailHtml({ candidates, langChanged: log.langChanged, langStats: stats, siteUrl }),
      });
      log.emailed = true;
    }

    return res.status(200).json(log);
  } catch (e) {
    log.errors.push(e.message);
    return res.status(500).json(log);
  }
};
