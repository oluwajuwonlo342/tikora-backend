// ==========================================
// Brevo transactional email via HTTP API
// Works on Render (uses port 443, not blocked like SMTP ports 25/465/587)
//
// Required env vars:
//   BREVO_API_KEY : Brevo > SMTP & API > API Keys tab
//   EMAIL_FROM    : a sender verified in Brevo
// ==========================================

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

export const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * @param {Object} options
 * @param {string} options.to
 * @param {string} [options.toName]
 * @param {string} options.subject
 * @param {string} options.html
 * @param {Array<{name: string, content: string}>} [options.attachments] content = base64 string
 * @param {string} [options.senderName]
 */
export const sendBrevoEmail = async ({
  to,
  toName,
  subject,
  html,
  attachments = [],
  senderName = "Tickora",
}) => {
  if (!process.env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is not set.");
  }

  if (!process.env.EMAIL_FROM) {
    throw new Error("EMAIL_FROM is not set.");
  }

  const payload = {
    sender: { name: senderName, email: process.env.EMAIL_FROM },
    to: [toName ? { email: to, name: toName } : { email: to }],
    subject,
    htmlContent: html,
  };

  if (attachments.length > 0) {
    payload.attachment = attachments.map((file) => ({
      name: file.name,
      content: file.content,
    }));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(BREVO_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `Brevo API ${response.status}: ${data.message || JSON.stringify(data)}`
      );
    }

    return data; // { messageId: "..." }
  } finally {
    clearTimeout(timeout);
  }
};