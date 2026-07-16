// Parses a CV (PDF, via Claude's native document support) into the site's
// experience/education/focusAreas shape, then emails an Approve link — the
// same human-in-the-loop pattern as api/scan.js, so a new CV never auto-
// publishes without a look first. Trigger manually (curl with the bearer
// token) or wire into its own Vercel Cron entry once CV_URL is set.

const { getFile, signToken, sendEmail } = require('./_lib');

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

async function fetchCvPdfBase64() {
  const url = process.env.CV_URL;
  if (!url) throw new Error('CV_URL is not set');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch CV_URL -> ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

async function draftCvSync({ text, pdfBase64, currentJson }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const instructions = `You are updating a portfolio's work-experience data from a CV/resume. The site's current experience/education/focusAreas JSON is shown below for context. Read the attached CV and output ONLY a JSON object with keys: experience (array of {role, org, period, points: [up to 3 short achievement bullets each]}), education (array of {name, meta}), focusAreas (array of up to 6 short skill/focus tags). Keep the same writing voice as the existing entries (concise, achievement-oriented, one clause per bullet). Order experience and education most-recent-first. If the CV doesn't give enough detail for a field, keep the corresponding existing entry unchanged.

Current data:
${JSON.stringify({ experience: currentJson.experience, education: currentJson.education, focusAreas: currentJson.focusAreas }, null, 2)}`;

  const content = [];
  if (pdfBase64) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } });
  }
  content.push({ type: 'text', text: (text ? `CV text:\n${text}\n\n` : '') + instructions });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API -> ${res.status} ${await res.text()}`);
  const data = await res.json();
  const textOut = (data.content || []).map((b) => b.text || '').join('');
  const match = textOut.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse CV draft as JSON: ' + textOut);
  return JSON.parse(match[0]);
}

module.exports = async (req, res) => {
  if (!isAuthorized(req)) {
    const configured = !!process.env.CRON_SECRET;
    return res.status(configured ? 401 : 503).json({
      error: configured ? 'unauthorized' : 'CRON_SECRET is not set — see SETUP.md before triggering this endpoint',
    });
  }

  try {
    const projectsFile = await getFile('data/projects.json');
    if (!projectsFile.json) throw new Error('data/projects.json is missing or unreadable');

    const body = req.body || {};
    const pdfBase64 = body.text ? null : await fetchCvPdfBase64();
    const draft = await draftCvSync({ text: body.text, pdfBase64, currentJson: projectsFile.json });

    const exp = Date.now() + TOKEN_TTL_MS;
    const token = signToken({ v: 1, action: 'cv-sync', draft, exp });
    const siteUrl = process.env.SITE_URL || 'https://port-three-taupe.vercel.app';
    const approveUrl = `${siteUrl}/api/approve?token=${encodeURIComponent(token)}`;

    const experience = draft.experience || [];
    const education = draft.education || [];
    const focusAreas = draft.focusAreas || [];

    await sendEmail({
      subject: 'Portfolio: CV changes ready to review',
      html: `
        <div style="font-family:sans-serif;max-width:560px;">
          <h2 style="margin:0 0 8px;">CV sync found updates</h2>
          <p style="color:#555;margin:0 0 12px;">
            ${experience.length} experience entr${experience.length === 1 ? 'y' : 'ies'},
            ${education.length} education entr${education.length === 1 ? 'y' : 'ies'},
            ${focusAreas.length} focus area(s) proposed.
          </p>
          <ul style="font-size:13px;color:#555;line-height:1.6;">
            ${experience.map((e) => `<li><b>${e.role}</b> — ${e.org} (${e.period})</li>`).join('')}
          </ul>
          <p>
            <a href="${approveUrl}" style="background:#4F46E5;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">Apply these changes</a>
          </p>
          <p style="font-size:12px;color:#999;">Ignore this email to leave the site unchanged — nothing is applied until you click. Link expires in 14 days.</p>
        </div>`,
    });

    return res.status(200).json({ ok: true, experience: experience.length, education: education.length, focusAreas: focusAreas.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
