// Sends email through Resend's HTTP API (no SDK needed) and holds the
// OrderPadi email look. sendEmail never throws; it returns true or false.
const RESEND_API_URL = 'https://api.resend.com/emails';

// Until you verify your own domain on Resend, onboarding@resend.dev only
// delivers to the email address that owns your Resend account. Once a domain
// is verified, set EMAIL_FROM in Netlify, e.g. "OrderPadi <no-reply@yourdomain.com>".
const fromAddress = () => process.env.EMAIL_FROM || 'OrderPadi <onboarding@resend.dev>';

const GREEN = '#0a7d4f';
const INK = '#141414';
const MUTED = '#6b6b66';
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail({ to, subject, html, text }) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('Email not sent: RESEND_API_KEY is not set.');
      return false;
    }
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: fromAddress(), to, subject, html, text })
    });
    if (!response.ok) {
      console.error('Email send error:', response.status, await response.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Email send error:', err);
    return false;
  }
}

// Table-based HTML with inline styles, because email apps ignore <style>.
function layout({ preheader, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>OrderPadi</title>
</head>
<body style="margin:0;padding:0;background:#f6f6f3;font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f3;">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4de;border-radius:16px;">
    <tr><td style="padding:24px 24px 0;font-size:20px;font-weight:700;color:${INK};">Order<span style="color:${GREEN};">Padi</span></td></tr>
    <tr><td style="padding:16px 24px 24px;">${body}</td></tr>
  </table>
  <div style="max-width:480px;padding:16px 12px 0;font-size:12px;line-height:1.5;color:${MUTED};">
    This is an automated message, so replies aren't read. OrderPadi will never ask you for this code by phone or WhatsApp.
  </div>
</td></tr>
</table>
</body>
</html>`;
}

const CODE_COPY = {
  signup: {
    heading: 'Confirm your email',
    intro: 'Enter this code in OrderPadi to finish setting up your store.',
    footer: "Didn't try to sign up? You can ignore this email."
  },
  reset: {
    heading: 'Reset your password',
    intro: 'Enter this code in OrderPadi to choose a new password.',
    footer: "Didn't ask to reset your password? Ignore this email and your password stays the same."
  }
};

function codeEmail({ code, purpose }) {
  const copy = CODE_COPY[purpose] || CODE_COPY.signup;
  const subject = `${code} is your OrderPadi code`;
  const html = layout({
    preheader: `${code} is your OrderPadi code. It expires in 10 minutes.`,
    body: `
      <h1 style="margin:0 0 10px;font-size:22px;color:${INK};">${esc(copy.heading)}</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${INK};">${esc(copy.intro)}</p>
      <div style="margin:0 0 18px;padding:18px;background:#e7f4ee;border-radius:12px;text-align:center;font-size:32px;font-weight:700;letter-spacing:0.3em;color:${INK};">${esc(code)}</div>
      <p style="margin:0 0 8px;font-size:14px;color:${MUTED};">The code expires in 10 minutes.</p>
      <p style="margin:0;font-size:14px;color:${MUTED};">${esc(copy.footer)}</p>`
  });
  const text = `${copy.heading}\n\n${copy.intro}\n\nYour code: ${code}\n\nIt expires in 10 minutes. ${copy.footer}`;
  return { subject, html, text };
}

module.exports = { sendEmail, codeEmail, esc, layout };
