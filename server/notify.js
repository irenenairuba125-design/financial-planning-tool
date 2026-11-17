'use strict';
/* Sends alerts by email (SMTP) and SMS (Africa's Talking).
   If a channel is not configured in .env, the message is only printed to the console ("dry run"). */

let transporter = null;
function mailer() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

async function sendEmail(to, subject, text) {
  const t = mailer();
  if (!t) {
    console.log(`[email dry run] to=${to} subject="${subject}"\n${text}`);
    return { ok: true, dryRun: true };
  }
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
  return { ok: true };
}

function normalizePhone(phone) {
  let p = String(phone || '').replace(/[\s-]/g, '');
  const cc = process.env.DEFAULT_COUNTRY_CODE || '256';
  if (/^0\d{8,}$/.test(p)) p = `+${cc}${p.slice(1)}`;
  if (/^\d{10,15}$/.test(p)) p = `+${p}`;
  return /^\+\d{10,15}$/.test(p) ? p : null;
}

async function sendSms(phone, text) {
  const to = normalizePhone(phone);
  if (!to) return { ok: false, error: 'Invalid phone number' };
  const { AT_USERNAME, AT_API_KEY, AT_SENDER_ID } = process.env;
  if (!AT_USERNAME || !AT_API_KEY) {
    console.log(`[sms dry run] to=${to}\n${text}`);
    return { ok: true, dryRun: true };
  }
  const host = AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
  const body = new URLSearchParams({ username: AT_USERNAME, to, message: text });
  if (AT_SENDER_ID) body.set('from', AT_SENDER_ID);
  const res = await fetch(`https://${host}/version1/messaging`, {
    method: 'POST',
    headers: { apiKey: AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`SMS failed: HTTP ${res.status} ${await res.text()}`);
  const json = await res.json();
  const r = json?.SMSMessageData?.Recipients?.[0];
  if (r && !/success/i.test(r.status)) throw new Error(`SMS failed: ${r.status}`);
  return { ok: true };
}

module.exports = { sendEmail, sendSms, normalizePhone };
