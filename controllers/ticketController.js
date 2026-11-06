import Event from '../models/Event.js';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import axios from 'axios';
import qrcode from 'qrcode';
import crypto from 'crypto';
import { sendBrevoEmail, escapeHtml } from '../utils/brevoMail.js';

// Prevents two simultaneous verify calls for the same reference from
// both creating tickets (e.g. React StrictMode / double redirect).
// Note: works for a single server instance. For multiple instances,
// use a DB-level lock instead.
const verifyInFlight = new Set();

// ==========================================
// HELPER: SEND TICKET EMAILS (Brevo HTTP API)
// Groups multiple tickets going to the same email into a single message
// ==========================================
const sendTicketEmails = async (ticketsData, event, isFree) => {
  const intro = isFree
    ? 'Your free registration was successful.'
    : 'Your payment was successful.';

  // 1. Group tickets by their destination email
  const groupedTickets = ticketsData.reduce((acc, ticket) => {
    const email = ticket._recipientEmail ? String(ticket._recipientEmail).trim() : null;
    if (email) {
      if (!acc[email]) acc[email] = [];
      acc[email].push(ticket);
    }
    return acc;
  }, {});

  // 2. Send one email per unique address
  const results = await Promise.allSettled(
    Object.entries(groupedTickets).map(async ([email, tickets]) => {

      const primaryAttendee = tickets[0].attendee;
      const primaryName = `${primaryAttendee.firstName || ''} ${primaryAttendee.lastName || ''}`.trim() || undefined;
      const ticketCountText = tickets.length > 1 ? `Here are your ${tickets.length} tickets:` : `Here is your ticket:`;

      // Build all attachments for this specific email
      const attachments = tickets.map(ticket => ({
        name: `Ticket-${ticket.ticketCode}.png`,
        content: ticket._base64,
      }));

      // Build the HTML breakdown for all tickets in this email
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
            <p>${intro} ${ticketCountText} The QR codes are attached to this email as images. Please present them at the gate for entry.</p>

            <div style="text-align: left; display: inline-block; width: 100%; max-width: 500px; margin-top: 10px;">
              ${ticketDetailsHtml}
            </div>
          </div>
        `,
        attachments: attachments,
      });

      return { email, count: tickets.length, skipped: false };
    })
  );

  // 3. Log results
  results.forEach((result) => {
    const label = isFree ? 'Free' : 'Paid';
    if (result.status === 'fulfilled') {
      if (!result.value.skipped) {
        console.log(`✅ ${label} email sent to ${result.value.email} with ${result.value.count} ticket(s).`);
      }
    } else {
      console.error(`❌ ${label} ticket email failed: ${result.reason?.message}`);
    }
  });
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

    const tier = event.tickets.find(t => t.name === ticketType);
    if (!tier) return res.status(400).json({ message: 'Invalid ticket type' });

    if (tier.quantity - tier.sold < qty) {
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
          ticketType,
          ticketCode: uniqueCode,
          qrCode: qrCodeDataUrl,
          price: 0,
          ticketPrice: 0,
          platformFee: 0,
          totalAmount: 0,
          paymentReference: freeReference,
          status: 'valid', // FIX: was 'active', which is not in the schema enum
          attendee: {
            firstName: attendee.firstName || attendees[0].firstName || 'Guest',
            lastName: attendee.lastName || attendees[0].lastName || '',
            email: recipientEmail,
            phone: attendee.phone || attendees[0].phone || ''
          },
          _base64: base64Image,
          _recipientEmail: recipientEmail
        });
      }

      const dbTickets = ticketsToCreate.map(({ _base64, _recipientEmail, ...rest }) => rest);
      await Ticket.insertMany(dbTickets);

      // FIX: atomic counter update (no validation / version-conflict failures)
      try {
        await Event.updateOne(
          { _id: eventId, 'tickets.name': ticketType },
          { $inc: { 'tickets.$.sold': qty, eventTicketsSold: qty } }
        );
      } catch (err) {
        console.error(`Free counter update failed for ${freeReference}:`, err.message);
      }

      // FIX: emails can never fail the registration
      try {
        await sendTicketEmails(ticketsToCreate, event, true);
      } catch (err) {
        console.error(`Free email sending failed for ${freeReference}:`, err.message);
      }

      return res.status(200).json({
        authorization_url: `/payment/verify?reference=${freeReference}`,
        reference: freeReference
      });
    }

    // ===============================================
    // CONTINUE TO PAYSTACK INITIALIZE FOR PAID TICKETS
    // ===============================================
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: buyerEmail,
        amount: Math.round(totalAmount * 100),
        callback_url: callback_url || undefined,
        metadata: {
          eventId: eventId.toString(),
          ticketType,
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

    // 1. Return existing tickets if this reference was already processed
    const existingTickets = await Ticket.find({ paymentReference: reference });
    if (existingTickets.length > 0) {
      return res.status(200).json({ success: true, message: "Already verified", tickets: existingTickets });
    }

    // Block simultaneous verify calls for the same reference
    if (verifyInFlight.has(reference)) {
      // Wait briefly for the first call to finish, then return its tickets
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        const done = await Ticket.find({ paymentReference: reference });
        if (done.length > 0) {
          return res.status(200).json({ success: true, message: "Already verified", tickets: done });
        }
      }
      return res.status(409).json({ success: false, message: "Verification is already in progress. Please refresh in a moment." });
    }
    verifyInFlight.add(reference);

    // 2. Verify transaction with Paystack API
    const paystackVerify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    const txData = paystackVerify.data.data;
    if (!txData || txData.status !== 'success') {
      return res.status(400).json({ success: false, message: "Payment verification failed or incomplete." });
    }

    const metadata = txData.metadata || {};
    let { buyerId, eventId, ticketType, quantity, attendees } = metadata;

    const buyerEmail = txData.customer?.email;
    const paidAmount = txData.amount / 100; // Converted from kobo

    // SAFETY FALLBACK: only used if Paystack stripped the metadata.
    // WARNING: this is a guess based on price. Two events with the same
    // price could match the wrong one. Prefer fixing why metadata is missing.
    if (!eventId || !ticketType || !quantity) {
      console.warn("⚠️ Paystack metadata missing/stripped. Attempting smart fallback deduction...");

      const allEvents = await Event.find({ status: "published" }).sort({ createdAt: -1 }).limit(10);
      let matchedEvent = null;
      let matchedTier = null;
      let matchedQty = 1;

      for (const ev of allEvents) {
        for (const tr of ev.tickets || []) {
          const expectedTotal = (tr.price * 1.07); // Price + 7% fee
          for (let q = 1; q <= 10; q++) {
            if (Math.abs((expectedTotal * q) - paidAmount) < 5) { // 5 Naira tolerance for rounding
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
        ticketType = matchedTier.name;
        quantity = matchedQty;
        attendees = Array.from({ length: quantity }, () => ({
          firstName: txData.customer?.first_name || 'Guest',
          lastName: txData.customer?.last_name || '',
          email: buyerEmail,
          phone: txData.customer?.phone || ''
        }));
      } else {
        console.error("Critical: Could not map transaction to any event/tier:", txData);
        return res.status(400).json({
          success: false,
          message: "Payment successful, but transaction metadata could not be resolved automatically. Please contact support with reference: " + reference
        });
      }
    }

    // Make sure attendees is always a usable array
    if (!Array.isArray(attendees)) attendees = [];

    // attendees.length is the source of truth for how many tickets to create
    const qty = attendees.length > 0 ? attendees.length : Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      return res.status(400).json({ success: false, message: "Invalid ticket quantity. Please contact support with reference: " + reference });
    }

    // Re-check database entry lock
    const reCheckedTickets = await Ticket.find({ paymentReference: reference });
    if (reCheckedTickets.length > 0) {
      return res.status(200).json({ success: true, message: "Already verified", tickets: reCheckedTickets });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      console.error(`Verify: payment ${reference} succeeded but event ${eventId} no longer exists.`);
      return res.status(404).json({ success: false, message: "Event not found for this transaction. Please contact support with reference: " + reference });
    }

    const tier = event.tickets.find(t => t.name === ticketType);
    if (!tier) {
      console.error(`Verify: payment ${reference} succeeded but ticket tier "${ticketType}" not found.`);
      return res.status(404).json({ success: false, message: "Ticket tier not found for this transaction. Please contact support with reference: " + reference });
    }

    let finalBuyerId = buyerId;
    if (!finalBuyerId && buyerEmail) {
      let guestUser = await User.findOne({ email: buyerEmail });
      if (!guestUser) {
        const randomPassword = crypto.randomBytes(8).toString('hex');
        guestUser = await User.create({
          name: txData.customer?.first_name || attendees[0]?.firstName || 'Guest User',
          email: buyerEmail,
          password: randomPassword,
          role: 'user'
        });
      }
      finalBuyerId = guestUser._id;
    }

    if (!finalBuyerId) {
      console.error(`Verify: could not determine buyer for ${reference}.`);
      return res.status(400).json({ success: false, message: "Could not determine the buyer. Please contact support with reference: " + reference });
    }

    const ticketsToCreate = [];
    const ticketPrice = tier.price;
    const platformFee = ticketPrice * 0.07;
    const totalAmount = ticketPrice + platformFee;

    for (let i = 0; i < qty; i++) {
      const attendee = attendees[i] || attendees[0] || {};
      const uniqueCode = `${reference}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${i + 1}`;

      const qrCodeDataUrl = await qrcode.toDataURL(uniqueCode);
      const base64Image = qrCodeDataUrl.split(';base64,').pop();
      const recipientEmail = attendee.email || buyerEmail;

      ticketsToCreate.push({
        event: eventId,
        buyer: finalBuyerId,
        organizer: event.organizer,
        ticketType,
        ticketCode: uniqueCode,
        qrCode: qrCodeDataUrl,
        price: ticketPrice,
        ticketPrice: ticketPrice,
        platformFee: platformFee,
        totalAmount: totalAmount,
        paymentReference: reference,
        status: 'valid', // FIX: was 'active', which is not in the schema enum
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

    // 3. Save tickets into the database FIRST
    const dbTickets = ticketsToCreate.map(({ _base64, _recipientEmail, ...rest }) => rest);
    const savedTickets = await Ticket.insertMany(dbTickets);

    // 4. Atomic counter update. A failure here must NOT fail the purchase.
    try {
      await Event.updateOne(
        { _id: eventId, 'tickets.name': ticketType },
        { $inc: { 'tickets.$.sold': qty, eventTicketsSold: qty, eventRevenue: paidAmount } }
      );
    } catch (err) {
      console.error(`Counter update failed for ${reference}:`, err.message);
    }

    // 5. Email delivery. A failure here must NOT fail the purchase.
    try {
      await sendTicketEmails(ticketsToCreate, event, false);
    } catch (err) {
      console.error(`Email sending failed for ${reference}:`, err.message);
    }

    return res.status(200).json({ success: true, message: "Tickets generated successfully", tickets: savedTickets });

  } catch (error) {
    console.error("Verification error details:", error.response?.data || error.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: "Server error during payment verification. Please contact support with your payment reference." });
    }
  } finally {
    if (reference) verifyInFlight.delete(reference);
  }
};

// ==========================================
// GET MY TICKETS (Buyer or Attendee)
// ==========================================
export const getMyTickets = async (req, res) => {
  try {
    // Includes tickets bought by the user AND tickets issued to their email
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
