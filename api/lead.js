// api/lead.js — Vercel serverless function.
//
// Receives contact-form submissions from amazingcthomes and emails them on.
// Runs on Vercel's Node runtime with zero npm dependencies: Resend is called
// over plain HTTPS, so there is no package.json and nothing to install.
//
// Why this exists rather than a hosted form service: the visitor's details
// (name, email, phone) are only ever held in transit. No third party keeps a
// database of your leads, and the API key stays server-side where nobody
// viewing the page source can read it.
//
// Required environment variable
//   RESEND_API_KEY   Your Resend API key. Set it in the Vercel dashboard,
//                    never in this file and never in the HTML.
//
// Optional environment variables
//   LEAD_TO          Recipient. Default: realksathya24@gmail.com
//   LEAD_FROM        Sender. Default: Resend's shared onboarding sender,
//                    which can only deliver to your own verified address.
//                    Once you own a domain, verify it in Resend and set this
//                    to something like "amazingcthomes <leads@yourdomain.com>".
//   ALLOWED_ORIGIN   If set, only accept posts from this origin.

const DEFAULT_TO = 'realksathya24@gmail.com';
const DEFAULT_FROM = 'amazingcthomes <onboarding@resend.dev>';
const MAX_FIELD = 2000;

// Order controls how the fields appear in the email.
const FIELDS = [
  ['topic', 'Enquiry type'],
  ['name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['town', 'Town'],
  ['budget', 'Budget'],
  ['alerts', 'Wants listing alerts'],
  ['message', 'Message']
];

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_FIELD);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Deliberately permissive: the point is to catch typos, not to police
// every valid address shape.
function looksLikeEmail(value) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value);
}

module.exports = async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Logged for you, not shown to the visitor — never leak config state.
    console.error('lead: RESEND_API_KEY is not set');
    return res.status(500).json({ ok: false, error: 'Mail is not configured yet.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ ok: false, error: 'Malformed request.' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Malformed request.' });
  }

  // Honeypot. Real people never see this field, so anything in it is a bot.
  // Answer 200 so the bot believes it succeeded and does not retry.
  if (clean(body.company)) {
    return res.status(200).json({ ok: true });
  }

  const data = {};
  FIELDS.forEach(function (pair) {
    data[pair[0]] = clean(body[pair[0]]);
  });

  if (!data.email && !data.phone) {
    return res.status(400).json({
      ok: false,
      error: 'Add an email address or a phone number so Kavitha can reply.'
    });
  }
  if (data.email && !looksLikeEmail(data.email)) {
    return res.status(400).json({ ok: false, error: 'That email address looks wrong.' });
  }

  const rows = FIELDS
    .filter(function (pair) { return data[pair[0]]; })
    .map(function (pair) {
      return '<tr>' +
        '<td style="padding:6px 14px 6px 0;color:#666;white-space:nowrap;vertical-align:top">' +
        escapeHtml(pair[1]) + '</td>' +
        '<td style="padding:6px 0"><strong>' + escapeHtml(data[pair[0]]) + '</strong></td>' +
        '</tr>';
    })
    .join('');

  const text = FIELDS
    .filter(function (pair) { return data[pair[0]]; })
    .map(function (pair) { return pair[1] + ': ' + data[pair[0]]; })
    .join('\n');

  const payload = {
    from: process.env.LEAD_FROM || DEFAULT_FROM,
    to: [process.env.LEAD_TO || DEFAULT_TO],
    subject: 'New enquiry' + (data.name ? ' from ' + data.name : '') +
             (data.town ? ' (' + data.town + ')' : ''),
    text: text,
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:15px">' +
          '<p style="margin:0 0 14px;color:#666">New enquiry from amazingcthomes</p>' +
          '<table style="border-collapse:collapse">' + rows + '</table>' +
          '</div>'
  };

  // Lets you hit Reply in Gmail and answer the enquirer directly.
  if (data.email) payload.reply_to = data.email;

  try {
    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error('lead: resend responded ' + upstream.status + ' ' + detail);
      return res.status(502).json({
        ok: false,
        error: 'Could not send just now. Please call or email instead.'
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('lead: ' + (err && err.message));
    return res.status(502).json({
      ok: false,
      error: 'Could not send just now. Please call or email instead.'
    });
  }
};
