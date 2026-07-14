const { verifyToken, getFile, putFile } = require('./_lib');

function page(title, body, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;text-align:center;color:#0A0A0B}
  h1{font-size:20px}p{color:#555;font-size:14px;line-height:1.6}
  .icon{font-size:40px;margin-bottom:12px}</style></head>
  <body><div class="icon">${ok ? '✅' : '⚠️'}</div><h1>${title}</h1><p>${body}</p></body></html>`;
}

module.exports = async (req, res) => {
  const { token } = req.query;
  let payload;
  try {
    payload = verifyToken(token);
  } catch (e) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(page('Link invalid or expired', e.message, false));
  }

  try {
    const known = await getFile('data/known-repos.json');
    const knownJson = known.json || { repos: [] };
    const existing = knownJson.repos.find((r) => r.repo === payload.repo);

    if (existing && existing.status === (payload.action === 'publish' ? 'published' : 'dismissed')) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(page('Already handled', `${payload.repo} was already ${existing.status} on ${existing.updatedAt}.`, true));
    }

    const today = new Date().toISOString().slice(0, 10);

    if (payload.action === 'publish') {
      const projectsFile = await getFile('data/projects.json');
      const projectsJson = projectsFile.json;
      projectsJson.projects = (projectsJson.projects || []).filter((p) => p.repo !== payload.repo);
      projectsJson.projects.push(payload.project);
      await putFile('data/projects.json', projectsJson, projectsFile.sha, `Add ${payload.project.name} to portfolio (email-approved)`);
    }

    if (existing) {
      existing.status = payload.action === 'publish' ? 'published' : 'dismissed';
      existing.updatedAt = today;
    } else {
      knownJson.repos.push({ repo: payload.repo, status: payload.action === 'publish' ? 'published' : 'dismissed', updatedAt: today });
    }
    await putFile('data/known-repos.json', knownJson, known.sha, `Mark ${payload.repo} as ${payload.action === 'publish' ? 'published' : 'dismissed'}`);

    res.setHeader('Content-Type', 'text/html');
    if (payload.action === 'publish') {
      return res.status(200).send(page('Published!', `${payload.repo} was added to the portfolio. Vercel is redeploying now — it should be live within a minute.`, true));
    }
    return res.status(200).send(page('Skipped', `${payload.repo} won't be suggested again unless it changes.`, true));
  } catch (e) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(page('Something went wrong', e.message, false));
  }
};
