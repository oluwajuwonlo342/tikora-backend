// controllers/adminEmail.controller.js
import User from "../models/User.js";

const MAX_RECIPIENTS = 500; // safety cap per send
const CHUNK_SIZE = 10; // emails sent at the same time
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUDIENCES = ["all", "organizers", "attendees", "new_users", "custom"];

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

// EMAIL_FROM can be   no-reply@yourdomain.com
// or                  "Tickora" <no-reply@yourdomain.com>
const parseSender = (from = "") => {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].trim() || "Tickora", email: match[2].trim() };
  return { name: "Tickora", email: from.trim() };
};

// Sends one email through Brevo's HTTP API (uses BREVO_API_KEY)
const sendEmail = async ({ to, toName, subject, html }) => {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: parseSender(process.env.EMAIL_FROM),
      to: [toName ? { email: to, name: toName } : { email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Brevo API error ${response.status}: ${details}`);
  }
};

const escapeHtml = (text = "") =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const firstNameOf = (name) => (name || "").trim().split(/\s+/)[0] || "there";

// Replaces {{name}} with the person's first name
const personalize = (text, firstName) =>
  text.replace(/\{\{\s*name\s*\}\}/gi, firstName);

// Turns the plain-text message into a branded HTML email
const renderEmailHtml = (message, firstName) => {
  const body = escapeHtml(personalize(message, firstName))
    .split(/\n{2,}/)
    .map(
      (para) =>
        `<p style="margin:0 0 16px;color:#444;font-size:15px;line-height:1.7;">${para.replace(
          /\n/g,
          "<br/>"
        )}</p>`
    )
    .join("");

  return `
    <div style="background:#f4f7f6;padding:24px 12px;font-family:Arial,sans-serif;">
      <div style="max-width:560px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;">
        <div style="background:#0a0a0a;padding:20px 28px;">
          <span style="color:#ffffff;font-size:20px;font-weight:bold;letter-spacing:1px;">
            TICK<span style="color:#ff5a36;">ORA</span>
          </span>
        </div>
        <div style="padding:28px;">${body}</div>
        <div style="padding:18px 28px;background:#fafafa;color:#999;font-size:12px;line-height:1.6;">
          You are receiving this email because you have an account on Tickora.
        </div>
      </div>
    </div>
  `;
};

const parseCustomEmails = (raw = "") => {
  const list = String(raw)
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(list)].filter((e) => EMAIL_REGEX.test(e));
};

// Works out who should receive the email
const getRecipients = async ({ audience, days, customEmails }) => {
  if (!AUDIENCES.includes(audience)) {
    const error = new Error("Invalid audience.");
    error.status = 400;
    throw error;
  }

  // Specific people typed in by the admin
  if (audience === "custom") {
    const emails = parseCustomEmails(customEmails);
    const users = await User.find({ email: { $in: emails } })
      .select("name email")
      .lean();
    const nameByEmail = new Map(users.map((u) => [u.email, u.name]));
    return emails.map((email) => ({ email, name: nameByEmail.get(email) || "" }));
  }

  // Never email suspended accounts
  const filter = { isActive: { $ne: false } };

  if (audience === "organizers") filter.role = "organizer";
  if (audience === "attendees") filter.role = "user";
  if (audience === "new_users") {
    const numberOfDays = Math.min(Math.max(Number(days) || 7, 1), 365);
    filter.createdAt = {
      $gte: new Date(Date.now() - numberOfDays * 24 * 60 * 60 * 1000),
    };
  }

  const users = await User.find(filter).select("name email").lean();
  return users.map((u) => ({ email: u.email, name: u.name || "" }));
};

// ---------------------------------------------------------------
// POST /api/admin/email/preview
// body: { audience, days, customEmails }
// Returns how many people would receive the email.
// ---------------------------------------------------------------
export const previewRecipients = async (req, res) => {
  try {
    const recipients = await getRecipients(req.body);

    return res.json({
      success: true,
      count: recipients.length,
      sample: recipients.slice(0, 5).map((r) => r.email),
      overLimit: recipients.length > MAX_RECIPIENTS,
      limit: MAX_RECIPIENTS,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error("previewRecipients error:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ---------------------------------------------------------------
// POST /api/admin/email/send
// body: { audience, days, customEmails, subject, message }
// ---------------------------------------------------------------
export const sendBroadcast = async (req, res) => {
  try {
    const subject = req.body.subject?.trim();
    const message = req.body.message?.trim();

    if (!subject || !message) {
      return res
        .status(400)
        .json({ success: false, message: "Subject and message are required." });
    }

    if (subject.length > 150 || message.length > 5000) {
      return res.status(400).json({
        success: false,
        message: "Subject must be under 150 characters and message under 5000.",
      });
    }

    const recipients = await getRecipients(req.body);

    if (recipients.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No recipients match this selection." });
    }

    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({
        success: false,
        message: `This would email ${recipients.length} people. The limit per send is ${MAX_RECIPIENTS}. Narrow the audience and try again.`,
      });
    }

    let sent = 0;
    const failedEmails = [];

    // Send in small batches so we don't overload Brevo or the server
    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      const chunk = recipients.slice(i, i + CHUNK_SIZE);

      const results = await Promise.allSettled(
        chunk.map((recipient) => {
          const firstName = firstNameOf(recipient.name);
          return sendEmail({
            to: recipient.email,
            toName: recipient.name,
            subject: personalize(subject, firstName),
            html: renderEmailHtml(message, firstName),
          });
        })
      );

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          sent += 1;
        } else {
          failedEmails.push(chunk[index].email);
          console.error(
            `Broadcast email to ${chunk[index].email} failed:`,
            result.reason?.message || result.reason
          );
        }
      });
    }

    console.log(
      `Admin broadcast "${subject}" by ${req.user?.id || "admin"}: ${sent} sent, ${failedEmails.length} failed`
    );

    return res.json({
      success: true,
      message:
        failedEmails.length === 0
          ? `Email sent to ${sent} recipient(s).`
          : `Sent to ${sent} recipient(s). ${failedEmails.length} failed.`,
      total: recipients.length,
      sent,
      failed: failedEmails.length,
      failedEmails: failedEmails.slice(0, 20),
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error("sendBroadcast error:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
