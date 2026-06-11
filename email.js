// email.js — invio email transazionali via Brevo (https://www.brevo.com)
const axios = require('axios');

const API = 'https://api.brevo.com/v3/smtp/email';
const KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM || '';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'photodin';

function emailEnabled() {
  return !!(KEY && FROM_EMAIL);
}

async function sendEmail({ to, subject, html }) {
  if (!emailEnabled()) {
    console.log('[email] non configurato (manca BREVO_API_KEY o EMAIL_FROM) — salto invio a', to);
    return;
  }
  await axios.post(
    API,
    {
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    },
    { headers: { 'api-key': KEY, 'Content-Type': 'application/json', accept: 'application/json' } }
  );
  console.log('[email] inviata a', to);
}

async function sendPhotosReadyEmail(order, link) {
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#16202e">
    <h2 style="color:#0f2a4a;margin-bottom:8px">Le tue foto sono pronte! ✨</h2>
    <p style="font-size:15px;line-height:1.6">Ciao, le foto professionali che hai creato con <strong>photodin</strong> sono pronte da vedere e scaricare.</p>
    <p style="text-align:center;margin:30px 0">
      <a href="${link}" style="background:#2f7df6;color:#ffffff;text-decoration:none;padding:14px 30px;border-radius:999px;font-weight:bold;font-size:16px;display:inline-block">Vedi le tue foto</a>
    </p>
    <p style="color:#5b6b80;font-size:13px;line-height:1.6">Le foto resteranno disponibili per un periodo limitato: scaricale appena puoi.<br>Grazie per aver scelto photodin.</p>
  </div>`;
  await sendEmail({ to: order.email, subject: 'Le tue foto photodin sono pronte! ✨', html });
}

module.exports = { sendEmail, sendPhotosReadyEmail, emailEnabled };
