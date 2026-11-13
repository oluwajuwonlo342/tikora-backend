import Event from '../models/Event.js';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import axios from 'axios';
import qrcode from 'qrcode';
import crypto from 'crypto';
import { sendBrevoEmail, escapeHtml } from '../utils/brevoMail.js';

// ==========================================
// HELPER: SEND TICKET EMAILS (Brevo HTTP API)
// ==========================================
const sendTicketEmails = async (ticketsData, event, isFree) => {
  const intro = isFree
    ? 'Your free registration was successful.'
    : 'Your payment was successful.';

  const groupedTickets = ticketsData.reduce((acc, ticket) => {
    const email = ticket._recipientEmail ? String(ticket._recipientEmail).trim() : null;
    if (email) {
      if (!acc[email]) acc[email] = [];
      acc[email].push(ticket);
    }
    return acc;
  }, {});

  const results = await Promise.allSettled(
    Object.entries(groupedTickets).map(async ([email, tickets]) => {
      const primaryAttendee = tickets[0].attendee;
      const primaryName = `${primaryAttendee.firstName || ''} ${primaryAttendee.lastName || ''}`.trim() || undefined;
      const ticketCountText = tickets.length > 1 ? `Here are your ${tickets.length} tickets:` : `Here is your ticket:`;

      const attachments = tickets.map(ticket => ({
        name: `Ticket-${ticket.ticketCode}.png`,
        content: ticket._base64,
      }));

      const ticketDetailsHtml = tickets.map(ticket => `
        <div style="background: white; padding: 15px; border-radius: 10px; border: 1px solid #eee; margin-top: 10px;">
          <p style="margin: 5px 0;"><strong>Attendee:</strong> ${escapeHtml(ticket.attendee.firstName)} ${escapeHtml(ticket.attendee.lastName)}</p>
          <p style="margin: 5px 0;"><strong>Ticket Type:</strong> ${escapeHtml(ticket.ticketType)}</p>
          <p style="margin: 5px 0;"><strong>Ticket Code:</strong> ${escapeHtml(ticket.ticketCode)}</p>
        </div>
      `).join('');

      await sendBrevoEmail({
        to: email,
        toName: primaryName,
        senderName: 'Tickora Events',
        subject: `Tickets Confirmed: ${event.title} (${tickets.length} Ticket${tickets.length > 1 ? 's' : ''})`,
        html: `
          <div style="font-family: sans-serif; padding: 20px; text-align: center; background: #f9f9f9;">
            <h2 style="color: #ff5a36;">You're going to ${escapeHtml(event.title)}!</h2>
            <p>Hi <strong>${escapeHtml(primaryAttendee.firstName)}</strong>,</p>
            <p>${intro} ${ticketCountText} The QR codes are attached to this email as images.</p>
            <div style="text-align: left; display: inline-block; width: 100%; max-width: 500px; margin-top: 10px;">
              ${ticketDetailsHtml}
            </div>
          </div>
        `,
        attachments: attachments,
      });
    })
  );
results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error('Ticket email failed:', result.reason?.message || result.reason);
    }
  });
};

// Sends emails in the background so the buyer never waits for them
const sendTicketEmailsInBackground = (ticketsData, event, isFree) => {
  sendTicketEmails(ticketsData, event, isFree).catch((err) =>
    console.error('Ticket email error:', err.message)
  );
};

// ==========================================
// HELPER: ATOMIC STOCK RESERVATION & ROLLBACK
//
// Checks remaining capacity AND increments sold count in one single
// MongoDB operation so two simultaneous buyers can never oversell a tier.
// ==========================================
const findTierIndex = (event, ticketType) =>
  (event.tickets || []).findIndex((t) => t.name === ticketType || t.title === ticketType);

const reserveStockAtomically = async (eventId, tierIndex, qty, revenue = 0) => {
  const result = await Event.updateOne(
    {
      _id: eventId,
      [`tickets.${tierIndex}`]: { $exists: true },
      $expr: {
        $gte: [
          {
            $subtract: [
              `$tickets.${tierIndex}.quantity`,
              { $ifNull: [`$tickets.${tierIndex}.sold`, 0] }
            ]
          },
          qty
        ]
      }
    },
    {
      $inc: {
        [`tickets.${tierIndex}.sold`]: qty,
        eventTicketsSold: qty,
        eventRevenue: revenue
      }
    }
  );

  return result.modifiedCount > 0;
};

const rollbackStockReservation = async (eventId, tierIndex, qty, revenue = 0) => {
  await Event.updateOne(
    { _id: eventId },
    {
      $inc: {
        [`tickets.${tierIndex}.sold`]: -qty,
        eventTicketsSold: -qty,
        eventRevenue: -revenue
      }
    }
  );
};

// ==========================================
// CORE: CREATE TICKETS FOR A PAID ORDER
// ==========================================
class FulfillmentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fulfillmentLocks = new Map();

const createTicketsForPayment = async ({ reference, eventId, ticketType, quantity, attendees, buyerId, buyerEmail, buyerName, paidAmount }) => {
  // Already done by an earlier run?
  const existingTickets = await Ticket.find({ paymentReference: reference });
  if (existingTickets.length > 0) {
    return { tickets: existingTickets, alreadyDone: true };
  }

  const attendeeList = Array.isArray(attendees) ? attendees : [];
  const qty = attendeeList.length > 0 ? attendeeList.length : Number(quantity);

  if (!eventId || !ticketType || !qty) {
    throw new FulfillmentError(400, 'Missing critical payment details for ' + reference);
  }
