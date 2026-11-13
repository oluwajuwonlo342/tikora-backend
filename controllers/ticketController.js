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
const event = await Event.findById(eventId);
  if (!event) throw new FulfillmentError(404, 'Event not found for this transaction.');

  const tierIndex = findTierIndex(event, ticketType);
  if (tierIndex === -1) throw new FulfillmentError(404, 'Ticket tier not found for this transaction.');

  const tier = event.tickets[tierIndex];

  // ATOMIC OVERSELL GUARD: Reserve stock in MongoDB BEFORE generating tickets
  const reserved = await reserveStockAtomically(eventId, tierIndex, qty, paidAmount);
  if (!reserved) {
    console.warn(`Oversell blocked for payment ${reference} on event ${eventId} (${ticketType})`);
    throw new FulfillmentError(
      409,
      'Sorry, this ticket tier sold out just before your payment completed. Please contact support for a refund.'
    );
  }

  try {
    // Find or create the buyer (guest checkout)
    let finalBuyerId = buyerId;
    if (!finalBuyerId && buyerEmail) {
      let guestUser = await User.findOne({ email: buyerEmail });
      if (!guestUser) {
        const randomPassword = crypto.randomBytes(8).toString('hex');
        guestUser = await User.create({
          name: buyerName || attendeeList[0]?.firstName || 'Guest User',
          email: buyerEmail,
          password: randomPassword,
          role: 'user'
        });
      }
      finalBuyerId = guestUser._id;
    }

    const ticketPrice = tier.price;
    const platformFee = ticketPrice * 0.07;
    const totalAmount = ticketPrice + platformFee;
    const ticketsToCreate = [];

    for (let i = 0; i < qty; i++) {
      const attendee = attendeeList[i] || attendeeList[0] || {};
      const uniqueCode = `${reference}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${i + 1}`;
      const qrCodeDataUrl = await qrcode.toDataURL(uniqueCode);
      const base64Image = qrCodeDataUrl.split(';base64,').pop();
      const recipientEmail = attendee.email || buyerEmail;

      ticketsToCreate.push({
        event: eventId,
        buyer: finalBuyerId,
        organizer: event.organizer,
        ticketType: tier.name || tier.title,
        ticketCode: uniqueCode,
        qrCode: qrCodeDataUrl,
        price: ticketPrice,
        ticketPrice: ticketPrice,
        platformFee: platformFee,
        totalAmount: totalAmount,
        paymentReference: reference,
        status: 'valid',
        attendee: {
          firstName: attendee.firstName || 'Guest',
          lastName: attendee.lastName || '',
          email: recipientEmail,
          phone: attendee.phone || ''
        },
        _base64: base64Image,
        _recipientEmail: recipientEmail
      });
    }

    // Save tickets to the database
    const dbTickets = ticketsToCreate.map(({ _base64, _recipientEmail, ...rest }) => rest);
    const savedTickets = await Ticket.insertMany(dbTickets);

    // Email the tickets in the background (the buyer does not wait for this)
    sendTicketEmailsInBackground(ticketsToCreate, event, false);

    return { tickets: savedTickets, alreadyDone: false };
  } catch (err) {
    // Roll back reserved stock if ticket creation failed unexpectedly
    await rollbackStockReservation(eventId, tierIndex, qty, paidAmount).catch((rbErr) =>
      console.error('Stock rollback failed:', rbErr.message)
    );
    throw err;
  }
};

const fulfillPaidOrder = (reference, params) => {
  if (fulfillmentLocks.has(reference)) return fulfillmentLocks.get(reference);
  const run = createTicketsForPayment({ reference, ...params }).finally(() => {
    fulfillmentLocks.delete(reference);
  });
  fulfillmentLocks.set(reference, run);
  return run;
};

// ==========================================
// HELPER: ASK PAYSTACK IF A PAYMENT WENT THROUGH
// ==========================================
const PENDING_STATUSES = ['pending', 'ongoing', 'processing', 'queued'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const verifyWithPaystack = async (reference) => {
  const MAX_ATTEMPTS = 4;
  const DELAY_MS = 2000;
  let lastError = null;
  let lastData = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }, timeout: 15000 }
      );
      lastData = response.data?.data || null;
      lastError = null;

      if (lastData?.status === 'success') return lastData;
      if (lastData && !PENDING_STATUSES.includes(lastData.status)) return lastData;
    } catch (error) {
      lastError = error;
      console.error(
        `Paystack verify attempt ${attempt} failed:`,
        error.response?.data || error.message
      );
    }
    if (attempt < MAX_ATTEMPTS) await sleep(DELAY_MS);
  }

  if (lastData) return lastData;
  throw lastError || new Error('Could not reach Paystack.');
};

// ==========================================
// INITIALIZE PURCHASE (Paystack or Free)
// ==========================================
export const initializePurchase = async (req, res) => {
  try {
    const { eventId, ticketType, quantity, attendees, callback_url } = req.body;
    const qty = Number(quantity);

    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ message: 'Quantity must be a whole number of at least 1.' });
    }

    if (!Array.isArray(attendees) || attendees.length !== qty) {
      return res.status(400).json({ message: 'Attendee details must match the ticket quantity.' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const tierIndex = findTierIndex(event, ticketType);
    if (tierIndex === -1) return res.status(400).json({ message: 'Invalid ticket type' });

    const tier = event.tickets[tierIndex];
    if ((tier.quantity - (tier.sold || 0)) < qty) {
      return res.status(400).json({ message: 'Not enough tickets available in this tier' });
    }

    const buyerEmail = req.user ? req.user.email : attendees[0].email;
    let buyerId = req.user ? req.user._id : null;

    const subtotal = tier.price * qty;
    const platformFee = subtotal * 0.07;
    const totalAmount = subtotal + platformFee;

    // ===============================================
    // FREE TICKET FAST-TRACK
    // ===============================================
    if (totalAmount === 0) {
      // Atomically reserve free tickets first so simultaneous clicks cannot oversell
      const reserved = await reserveStockAtomically(eventId, tierIndex, qty, 0);
      if (!reserved) {
        return res.status(409).json({ message: 'Sorry, this ticket tier just sold out.' });
      }

      try {
        const freeReference = `FREE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

        if (!buyerId) {
          let guestUser = await User.findOne({ email: buyerEmail });
          if (!guestUser) {
            const randomPassword = crypto.randomBytes(8).toString('hex');
            guestUser = await User.create({
              name: attendees[0]?.firstName || 'Guest User',
              email: buyerEmail,
              password: randomPassword,
              role: 'user'
            });
          }
          buyerId = guestUser._id;
        }

        const ticketsToCreate = [];
        for (let i = 0; i < attendees.length; i++) {
          const attendee = attendees[i];
          const uniqueCode = `${freeReference}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${i + 1}`;
          const qrCodeDataUrl = await qrcode.toDataURL(uniqueCode);
          const base64Image = qrCodeDataUrl.split(';base64,').pop();
          const recipientEmail = attendee.email || attendees[0].email;

          ticketsToCreate.push({
            event: eventId,
            buyer: buyerId,
            organizer: event.organizer,
            ticketType: tier.name || tier.title,
            ticketCode: uniqueCode,
            qrCode: qrCodeDataUrl,
            price: 0,
            ticketPrice: 0,
            platformFee: 0,
            totalAmount: 0,
            paymentReference: freeReference,
            status: 'valid',
            attendee: {
              firstName: attendee.firstName || 'Guest',
              lastName: attendee.lastName || '',
              email: recipientEmail,
              phone: attendee.phone || ''
            },
            _base64: base64Image,
            _recipientEmail: recipientEmail
          });
        }

        const dbTickets = ticketsToCreate.map(({ _base64, _recipientEmail, ...rest }) => rest);
        await Ticket.insertMany(dbTickets);
        sendTicketEmailsInBackground(ticketsToCreate, event, true);

        return res.status(200).json({
          authorization_url: `/payment/verify?reference=${freeReference}`,
          reference: freeReference
        });
      } catch (freeErr) {
        await rollbackStockReservation(eventId, tierIndex, qty, 0).catch(() => {});
        throw freeErr;
      }
    }

    // ===============================================
    // PAID TICKETS (PAYSTACK INITIALIZE)
    // ===============================================
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: buyerEmail,
        amount: Math.round(totalAmount * 100),
        callback_url: callback_url || undefined,
        metadata: {
          eventId: eventId.toString(),
          ticketType: tier.name || tier.title,
          quantity: qty,
          buyerId: buyerId ? buyerId.toString() : null,
          attendees
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.status(200).json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference
    });
  } catch (error) {
    console.error('Paystack Init Error:', error.response?.data || error.message);
    return res.status(500).json({ message: 'Failed to initialize payment' });
  }
};

// ==========================================
// VERIFY PURCHASE & GENERATE TICKETS
// ==========================================
export const verifyPurchase = async (req, res) => {
  const reference = req.body?.reference || req.query?.reference;

  try {
    if (!reference) {
      return res.status(400).json({ success: false, message: "Transaction reference is required." });
    }

    // 1. Fast path: tickets already exist for this reference
    const existingTickets = await Ticket.find({ paymentReference: reference });
    if (existingTickets.length > 0) {
      return res.status(200).json({ success: true, message: "Already verified", tickets: existingTickets });
    }

    // 2. Ask Paystack (waits a few seconds if the payment is still settling)
    const txData = await verifyWithPaystack(reference);
    if (!txData || txData.status !== 'success') {
      if (txData && PENDING_STATUSES.includes(txData.status)) {
        return res.status(202).json({
          success: false,
          pending: true,
          message: "Your payment is still being confirmed. Please wait a moment and refresh this page. If you were charged, your tickets will appear automatically."
        });
      }
      return res.status(400).json({ success: false, message: "Payment verification failed or incomplete." });
    }

    const metadata = txData.metadata || {};
    let { buyerId, eventId, ticketType, quantity, attendees } = metadata;
    const buyerEmail = txData.customer?.email;
    const paidAmount = txData.amount / 100;

    // 3. Fallback if metadata was stripped by Paystack
    if (!eventId || !ticketType || !quantity) {
      const allEvents = await Event.find({ status: "published" }).sort({ createdAt: -1 }).limit(10);
      let matchedEvent = null;
      let matchedTier = null;
      let matchedQty = 1;

      for (const ev of allEvents) {
        for (const tr of ev.tickets || []) {
          const expectedTotal = (tr.price * 1.07);
          for (let q = 1; q <= 10; q++) {
            if (Math.abs((expectedTotal * q) - paidAmount) < 5) {
              matchedEvent = ev;
              matchedTier = tr;
              matchedQty = q;
              break;
            }
          }
          if (matchedEvent) break;
        }
        if (matchedEvent) break;
      }

      if (matchedEvent && matchedTier) {
        eventId = matchedEvent._id.toString();
        ticketType = matchedTier.name || matchedTier.title;
        quantity = matchedQty;
        attendees = Array.from({ length: quantity }, () => ({
          firstName: txData.customer?.first_name || 'Guest',
          lastName: txData.customer?.last_name || '',
          email: buyerEmail,
          phone: txData.customer?.phone || ''
        }));
      } else {
        return res.status(400).json({
          success: false,
          message: "Payment successful, but transaction metadata could not be resolved automatically. Reference: " + reference
        });
      }
    }

    // 4. Create the tickets (with atomic stock protection)
    const result = await fulfillPaidOrder(reference, {
      eventId,
      ticketType,
      quantity,
      attendees,
      buyerId,
      buyerEmail,
      buyerName: txData.customer?.first_name,
      paidAmount
    });

    return res.status(200).json({
      success: true,
      message: result.alreadyDone ? "Already verified" : "Tickets generated successfully",
      tickets: result.tickets
    });
  } catch (error) {
    console.error("Verification error details:", error.response?.data || error.message);
    if (!res.headersSent) {
      if (error instanceof FulfillmentError) {
        return res.status(error.status).json({ success: false, message: error.message });
      }
      return res.status(500).json({ success: false, message: "Server error during payment verification." });
    }
  }
};

// ==========================================
// GET MY TICKETS
// ==========================================
export const getMyTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find({
      $or: [
        { buyer: req.user._id },
        { 'attendee.email': req.user.email }
      ]
    })
      .populate("event", "title image date endDate venue location category")
      .populate("organizer", "name email avatar")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    console.error("Get my tickets error:", error);
    return res.status(500).json({ success: false, message: "Unable to load your tickets." });
  }
};

// ==========================================
// GET SINGLE TICKET BY ID
// ==========================================
export const getTicketById = async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id)
      .populate("event", "title image date endDate venue location category")
      .populate("buyer", "name email avatar")
      .populate("organizer", "name email avatar");

    if (!ticket) {
      return res.status(404).json({ success: false, message: "Ticket not found." });
    }

    const isBuyer = ticket.buyer?._id?.toString() === req.user._id.toString();
    const isOrganizer = ticket.organizer?._id?.toString() === req.user._id.toString();
    const isAttendee =
      !!ticket.attendee?.email &&
      ticket.attendee.email.toLowerCase() === String(req.user.email).toLowerCase();

    if (!isBuyer && !isOrganizer && !isAttendee) {
      return res.status(403).json({ success: false, message: "You are not authorized to view this ticket." });
    }

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error("Get ticket error:", error);
    return res.status(500).json({ success: false, message: "Unable to load ticket." });
  }
};

// ==========================================
// VERIFY & CHECK-IN TICKET (Organizer)
// ==========================================
export const verifyAndCheckInTicket = async (req, res) => {
  try {
    const { ticketCode } = req.body;
    if (!ticketCode) {
      return res.status(400).json({ success: false, message: "Ticket code is required." });
    }

    const ticket = await Ticket.findOne({ ticketCode: ticketCode.trim() })
      .populate("event", "title date venue organizer")
      .populate("buyer", "name email");

    if (!ticket) {
      return res.status(404).json({ success: false, statusType: "INVALID", message: "Invalid ticket. Ticket does not exist." });
    }

    if (ticket.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        statusType: "INVALID",
        message: "Unauthorized: This ticket belongs to an event organized by someone else."
      });
    }

    if (ticket.status === 'cancelled') {
      return res.status(400).json({ success: false, statusType: "CANCELLED", message: `This ${ticket.ticketType} ticket has been cancelled.` });
    }

    if (ticket.status === 'used') {
      const formattedCheckInTime = new Date(ticket.usedAt).toLocaleString('en-NG', {
        timeZone: 'Africa/Lagos',
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      return res.status(400).json({
        success: false,
        statusType: "ALREADY_USED",
        message: `ALREADY USED: This ${ticket.ticketType} ticket was already checked in at ${formattedCheckInTime}`
      });
    }

    ticket.status = 'used';
    ticket.usedAt = new Date();
    await ticket.save();

    const holderName = ticket.attendee ? `${ticket.attendee.firstName} ${ticket.attendee.lastName}`.trim() : ticket.buyer?.name;
    const holderEmail = ticket.attendee ? ticket.attendee.email : ticket.buyer?.email;

    return res.status(200).json({
      success: true,
      statusType: "VALID",
      message: `VALID TICKET - ${ticket.ticketType} Check-in successful!`,
      ticket: {
        ticketCode: ticket.ticketCode,
        ticketType: ticket.ticketType,
        holderName,
        holderEmail,
        eventTitle: ticket.event?.title,
        usedAt: ticket.usedAt
      }
    });
  } catch (error) {
    console.error("Ticket verification error:", error);
    return res.status(500).json({ success: false, message: "Server error during ticket verification." });
  }
};


// ==========================================
// PAYSTACK WEBHOOK (Background Verification)
// ==========================================
export const paystackWebhook = async (req, res) => {
  try {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
                       .update(rawBody)
                       .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.error('Paystack webhook rejected: invalid signature');
      return res.status(400).send('Invalid signature');
    }

    const paystackEvent = req.body;

    if (paystackEvent.event === 'charge.success') {
      const txData = paystackEvent.data;
      const reference = txData.reference;
      const metadata = txData.metadata || {};
      const { buyerId, eventId, ticketType, quantity, attendees } = metadata;

      if (!eventId || !ticketType) {
        console.error(`Webhook Error: Missing critical metadata for ${reference}`);
        return res.status(200).send('Webhook received, but metadata is missing.');
      }

      console.log(`Webhook triggered for ${reference}. Making sure tickets exist...`);
      try {
        const result = await fulfillPaidOrder(reference, {
          eventId,
          ticketType,
          quantity,
          attendees,
          buyerId,
          buyerEmail: txData.customer?.email,
          buyerName: txData.customer?.first_name,
          paidAmount: txData.amount / 100
        });
        console.log(
          result.alreadyDone
            ? `Webhook: tickets for ${reference} already existed.`
            : `Webhook created tickets for ${reference}.`
        );
      } catch (error) {
        console.error(`Webhook could not create tickets for ${reference}:`, error.message);
      }
    }

    res.status(200).send('Webhook successfully received');
  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(200).send('Webhook caught an internal error');
  }
};
