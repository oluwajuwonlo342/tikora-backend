// utils/payoutEmails.js
// All emails about payouts: request received, approved, rejected, and the alert to the admin.
import { sendBrevoEmail, escapeHtml } from './brevoMail.js';

// Where "new payout request" alerts go. Set ADMIN_NOTIFY_EMAIL on Render to change it
// without touching the code.
const getAdminEmail = () =>
  process.env.ADMIN_NOTIFY_EMAIL || 'oluwajuwonloadedayo69@gmail.com';

const naira = (value) => `₦${(Number(value) || 0).toLocaleString('en-NG')}`;

const maskAccount = (accountNumber = '') => {
  const digits = String(accountNumber);
  return digits.length > 4 ? `****${digits.slice(-4)}` : digits;
};

// Sends an email and never lets a failed email break the payout itself
const safeSend = async (label, options) => {
  try {
    await sendBrevoEmail({ senderName: 'Tickora', ...options });
  } catch (error) {
    console.error(`Payout email failed (${label}):`, error.message);
  }
};

// ---------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------
const layout = ({ heading, intro, boxTitle, boxHtml, boxColor = '#fff4ef', boxBorder = '#ffd9cc', extraHtml = '' }) => `
  <div style="background:#f4f4f4;padding:24px 12px;font-family:Arial,sans-serif;">
    <div style="max-width:520px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;">
      <div style="background:#0a0a0a;padding:26px;text-align:center;">
        <span style="color:#ffffff;font-size:26px;font-weight:bold;">Tick<span style="color:#ff5a36;">ora</span></span>
        <div style="color:#aaaaaa;font-size:13px;margin-top:6px;">Event ticketing made simple</div>
      </div>

      <div style="padding:32px 28px;">
        <h2 style="margin:0 0 14px;color:#111111;font-size:24px;">${heading}</h2>
        <p style="margin:0 0 22px;color:#555555;font-size:15px;line-height:1.7;">${intro}</p>

        ${boxTitle ? `
        <div style="background:${boxColor};border:1px solid ${boxBorder};border-radius:12px;padding:18px 20px;">
          <strong style="display:block;color:#111111;font-size:15px;margin-bottom:6px;">${boxTitle}</strong>
          <span style="color:#555555;font-size:14px;line-height:1.7;">${boxHtml}</span>
        </div>` : ''}

        ${extraHtml}
      </div>

      <div style="padding:18px 28px;background:#fafafa;color:#999999;font-size:12px;text-align:center;line-height:1.6;">
        Sent by Tickora. If you did not expect this email, please contact support.
      </div>
    </div>
  </div>
`;

const detailRow = (label, value) => `
  <tr>
    <td style="padding:6px 0;color:#888888;font-size:13px;width:40%;">${label}</td>
    <td style="padding:6px 0;color:#111111;font-size:14px;font-weight:bold;">${value}</td>
  </tr>
`;

// ---------------------------------------------------------------
// 1. Payout REQUESTED: email to the organizer AND to the admin
// ---------------------------------------------------------------
export const sendPayoutRequestedEmails = async ({ payout, organizer, eventTitle }) => {
  const amount = naira(payout.amount);
  const bank = payout.bankDetails || {};
  const title = escapeHtml(eventTitle || 'your event');

  // Email to the organizer
  if (organizer?.email) {
    await safeSend('requested -> organizer', {
      to: organizer.email,
      toName: organizer.name,
      subject: 'Payout Request Received — Tickora',
      html: layout({
        heading: 'Payout Request Received',
        intro: `We have received your payout request of <strong>${amount}</strong> for <strong>${title}</strong>. Our team will process it within 24 hours.`,
        boxTitle: '⏳ What happens next?',
        boxHtml: `Once processed, the money will be sent to your ${escapeHtml(bank.bankName || 'bank')} account (${escapeHtml(maskAccount(bank.accountNumber))}). You'll receive another email as soon as your payout is approved.`
      })
    });
  }

  // Alert to the admin
  const clientUrl = (process.env.CLIENT_URL || '').replace(/\/$/, '');
  await safeSend('requested -> admin', {
    to: getAdminEmail(),
    subject: `New payout request: ${amount} from ${organizer?.name || 'an organizer'}`,
    html: layout({
      heading: 'New Payout Request 🔔',
      intro: `<strong>${escapeHtml(organizer?.name || 'An organizer')}</strong> has requested a payout and it is waiting for your approval.`,
      extraHtml: `
        <table style="width:100%;border-collapse:collapse;margin-bottom:22px;">
          ${detailRow('Amount', amount)}
          ${detailRow('Event', title)}
          ${detailRow('Organizer', escapeHtml(organizer?.name || 'Unknown'))}
          ${detailRow('Organizer email', escapeHtml(organizer?.email || 'Unknown'))}
          ${detailRow('Bank', escapeHtml(bank.bankName || '—'))}
          ${detailRow('Account number', escapeHtml(bank.accountNumber || '—'))}
          ${detailRow('Account name', escapeHtml(bank.accountName || '—'))}
        </table>
        ${clientUrl ? `
        <p style="text-align:center;margin:0;">
          <a href="${clientUrl}/admin/login"
             style="background:#ff5a36;color:#ffffff;padding:14px 26px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block;">
            Review in Admin Dashboard
          </a>
        </p>` : ''}
      `
    })
  });
};

// ---------------------------------------------------------------
// 2. Payout APPROVED: email to the organizer
// `payout` must have organizer {name,email} and event {title} populated.
// ---------------------------------------------------------------
export const sendPayoutApprovedEmail = async ({ payout }) => {
  const organizer = payout.organizer;
  if (!organizer?.email) return;

  const bank = payout.bankDetails || {};
  const title = escapeHtml(payout.event?.title || 'your event');

  await safeSend('approved -> organizer', {
    to: organizer.email,
    toName: organizer.name,
    subject: 'Your Payout Has Been Approved — Tickora',
    html: layout({
      heading: 'Payout Approved ✅',
      intro: `Your payout request of <strong>${naira(payout.amount)}</strong> for <strong>${title}</strong> has been <strong style="color:#00a050;">approved</strong> by the Tickora team.`,
      boxTitle: '💰 Funds on the way',
      boxColor: '#eefaf3',
      boxBorder: '#c7ecd6',
      boxHtml: `The money has been sent to your ${escapeHtml(bank.bankName || 'bank')} account (${escapeHtml(maskAccount(bank.accountNumber))}). It should reflect shortly, and within 1 to 2 business days at most.
        ${payout.paymentReference ? `<br/><br/>Transfer reference: <strong>${escapeHtml(payout.paymentReference)}</strong>` : ''}`
    })
  });
};

// ---------------------------------------------------------------
// 3. Payout REJECTED: email to the organizer, with the reason
// ---------------------------------------------------------------
export const sendPayoutRejectedEmail = async ({ payout }) => {
  const organizer = payout.organizer;
  if (!organizer?.email) return;

  const title = escapeHtml(payout.event?.title || 'your event');

  await safeSend('rejected -> organizer', {
    to: organizer.email,
    toName: organizer.name,
    subject: 'Your Payout Request Was Not Approved — Tickora',
    html: layout({
      heading: 'Payout Request Declined',
      intro: `Your payout request of <strong>${naira(payout.amount)}</strong> for <strong>${title}</strong> could not be approved.`,
      boxTitle: 'Reason',
      boxColor: '#fff1f1',
      boxBorder: '#ffd0d0',
      boxHtml: `${escapeHtml(payout.rejectionReason || 'No reason was given.')}<br/><br/>The amount is back in your available balance, so you can submit a new request any time.`
    })
  });
};