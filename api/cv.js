// Gated CV flow: POST = visitor requests the CV; GET ?token= = owner-approved
// link that emails the CV to the requester. State lives entirely in the signed
// token, so no database is needed. The CV itself is never a public repo file —
// approval emails out CV_URL (set it in Vercel env to a private share link).

const { signToken, verifyToken, sendEmail } = require('./_lib');

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function clean(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(title, body, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;text-align:center;color:#0A0A0B}
  h1{font-size:20px}p{color:#555;font-size:14px;line-height:1.6}.icon{font-size:40px;margin-bottom:12px}</style></head>
  <body><div class="icon">${ok ? '✅' : '⚠️'}</div><h1>${title}</h1><p>${body}</p></body></html>`;
}

module.exports = async (req, res) => {
  const siteUrl = process.env.SITE_URL || 'https://port-three-taupe.vercel.app';

  if (req.method === 'POST') {
    const b = req.body || {};
    if (b.website) return res.status(200).json({ ok: true }); // honeypot

    const name = clean(b.name, 80);
    const email = clean(b.email, 120);
    const reason = clean(b.reason, 600);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Name and a valid email are required.' });
    }

    try {
      const token = signToken({ v: 1, action: 'cv', name, email, exp: Date.now() + TOKEN_TTL_MS });
      await sendEmail({
        subject: `CV request from ${name}`,
        replyTo: email,
        html: `
          <div style="font-family:sans-serif;max-width:560px;">
            <h2 style="margin:0 0 12px;">Someone requested your CV</h2>
            <p><b>${escHtml(name)}</b> &lt;${escHtml(email)}&gt;</p>
            ${reason ? `<div style="border-left:3px solid #4F46E5;padding:8px 14px;background:#FAFAFB;font-size:14px;line-height:1.6;">${escHtml(reason)}</div>` : ''}
            <p style="margin-top:18px;">
              <a href="${siteUrl}/api/cv?token=${encodeURIComponent(token)}"
                 style="background:#4F46E5;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">
                 Approve — email them the CV</a>
            </p>
            <p style="font-size:12px;color:#999;">Ignore this email to decline. The link expires in 14 days.</p>
          </div>`,
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(503).json({ error: 'Mail service not configured or unavailable.' });
    }
  }

  // GET: owner clicked Approve
  let payload;
  try {
    payload = verifyToken(req.query.token);
    if (payload.action !== 'cv') throw new Error('Wrong token type');
  } catch (e) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(page('Link invalid or expired', e.message, false));
  }

  const cvUrl = process.env.CV_URL;
  res.setHeader('Content-Type', 'text/html');
  if (!cvUrl) {
    return res.status(500).send(page('CV_URL not configured',
      'Set the CV_URL environment variable in Vercel to a shareable link to your CV, then click this approve link again.', false));
  }

  try {
    await sendEmail({
      to: payload.email,
      subject: 'Brian Matoke — CV, as requested',
      html: `
        <div style="font-family:sans-serif;max-width:560px;">
          <p>Hi ${escHtml(payload.name)},</p>
          <p>Thanks for your interest — here is my CV:</p>
          <p><a href="${escHtml(cvUrl)}" style="background:#4F46E5;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">Open CV</a></p>
          <p style="font-size:13px;color:#555;">Feel free to reply to this email directly.<br>— Brian Matoke</p>
        </div>`,
      replyTo: process.env.OWNER_EMAIL,
    });
    return res.status(200).send(page('CV sent', `Emailed the CV to ${escHtml(payload.email)}.`, true));
  } catch (e) {
    return res.status(500).send(page('Sending failed', escHtml(e.message), false));
  }
};
