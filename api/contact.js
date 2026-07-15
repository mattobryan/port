const { sendEmail } = require('./_lib');

function clean(s, max) {
  return String(s == null ? '' : s).trim().slice(0, max);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const b = req.body || {};
  // honeypot: bots fill every field; humans never see this one
  if (b.website) return res.status(200).json({ ok: true });

  const name = clean(b.name, 80);
  const email = clean(b.email, 120);
  const subject = clean(b.subject, 140);
  const message = clean(b.message, 4000);

  if (!name || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Name, a valid email, and a message are required.' });
  }

  try {
    await sendEmail({
      subject: `Portfolio contact: ${subject || name}`,
      replyTo: email,
      html: `
        <div style="font-family:sans-serif;max-width:560px;">
          <h2 style="margin:0 0 4px;">New message from the portfolio</h2>
          <p style="color:#888;font-size:13px;margin:0 0 16px;">Reply to this email to answer directly.</p>
          <p><b>${escHtml(name)}</b> &lt;${escHtml(email)}&gt;</p>
          ${subject ? `<p><b>Subject:</b> ${escHtml(subject)}</p>` : ''}
          <div style="border-left:3px solid #4F46E5;padding:8px 14px;background:#FAFAFB;white-space:pre-wrap;font-size:14px;line-height:1.6;">${escHtml(message)}</div>
        </div>`,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(503).json({ error: 'Mail service not configured or unavailable.' });
  }
};
