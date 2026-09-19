import Event from '../models/Event.js';
import Ticket from '../models/Ticket.js';
import User from '../models/User.js';
import axios from 'axios';
import qrcode from 'qrcode';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

// ==========================================
// HELPER: CREATE TRANSPORTER (FIXED PORT)
// ==========================================
const createTransporter = () => {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // MUST be false for 587
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

const generateTicketCode = () => {
  return 'EVT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
};

// ==========================================
// INITIALIZE PURCHASE (Paystack or Free)
// ==========================================
export const initializePurchase = async (req, res) => {
  try {
    const { eventId, ticketType, quantity, attendees, callback_url } = req.body;
    
    if (!attendees || attendees.length !== Number(quantity)) {
      return res.status(400).json({ message: 'Attendee details must match the ticket quantity.' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const tier = event.tickets.find(t => t.name === ticketType);
    if (!tier) return res.status(400).json({ message: 'Invalid ticket type' });
    
    if (tier.quantity - tier.sold < quantity) {
      return res.status(400).json({ message: 'Not enough tickets available in this tier' });
    }

    const buyerEmail = req.user ? req.user.email : attendees[0].email;
    const buyerId = req.user ? req.user._id : null; 

    const subtotal = tier.price * quantity;
    const platformFee = subtotal * 0.07;
    const totalAmount = subtotal + platformFee;

    // ===============================================
    // FREE TICKET FAST-TRACK
    // ===============================================
    if (totalAmount === 0) {
      const freeReference = `FREE-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      
      tier.sold += Number(quantity);
      event.eventTicketsSold = (event.eventTicketsSold || 0) + Number(quantity);
      await event.save();

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
          paymentReference: `${freeReference}-${i}`,     
          attendee: {
            firstName: attendee.firstName || attendees[0].firstName,
            lastName: attendee.lastName || attendees[0].lastName,
            email: recipientEmail,
            phone: attendee.phone || attendees[0].phone
          },
          _base64: base64Image,
          _recipientEmail: recipientEmail
        });
      }

      const dbTickets = ticketsToCreate.map(({ _base64, _recipientEmail, ...rest }) => rest);
      await Ticket.insertMany(dbTickets);

      // ✅ FIX: Await email sending BEFORE sending response so Render doesn't kill it
      try {
        const transporter = createTransporter();
        for (let i = 0; i < ticketsToCreate.length; i++) {
          const ticket = ticketsToCreate[i];
          const safeEmail = ticket._recipientEmail ? String(ticket._recipientEmail).trim() : null;
          if (!safeEmail) continue;

          await transporter.sendMail({
            from: '"Tickora Events" <no-reply@tickora.com>',
            to: safeEmail,
            subject: `Ticket Confirmed: ${event.title} (${ticket.ticketCode})`,
            html: `
              <div style="font-family: 'Space Grotesk', sans-serif; padding: 20px; text-align: center; background: #f9f9f9;">
                <h2 style="color: #ff5a36;">You're going to ${event.title}!</h2>
                <p>Hi <strong>${ticket.attendee.firstName}</strong>,</p>
                <p>Your free registration was successful. Please present the QR code below at the gate.</p>
                <div style="margin: 30px 0;">
                  <img src="cid:ticket-qr-${i}" alt="Ticket QR Code" style="width: 200px; height: 200px; border-radius: 10px; border: 2px solid #ddd;" />
                </div>
                <div style="background: white; padding: 15px; border-radius: 10px; display: inline-block; text-align: left; border: 1px solid #eee;">
                  <p style="margin: 5px 0;"><strong>Ticket Type:</strong> ${ticket.ticketType}</p>
                  <p style="margin: 5px 0;"><strong>Ticket Code:</strong> ${ticket.ticketCode}</p>
                </div>
              </div>
            `,
            attachments: [
              { filename: `inline-qr-${ticket.ticketCode}.png`, content: ticket._base64, encoding: 'base64', cid: `ticket-qr-${i}` },
              { filename: `Download-Ticket-${ticket.ticketCode}.png`, content: ticket._base64, encoding: 'base64', contentType: 'image/png', disposition: 'attachment' }
            ]
          });
          console.log(`Free ticket successfully sent to ${safeEmail}`);
        }
      } catch (err) {
        console.error(`Free email error: ${err.message}`);
      }

      // ✅ FIX: Send response AFTER emails are safely sent
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
          eventId,
          ticketType,
          quantity,
          buyerId,
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
  try {
    const reference = req.body.reference || req.query.reference;
    if (!reference) return res.status(400).json({ success: false, message: "Transaction reference is required." });

    if (reference.startsWith('FREE-')) {
      const freeTickets = await Ticket.find({ paymentReference: new RegExp(`^${reference}`) });
      if (freeTickets.length > 0) {
        return res.status(200).json({ success: true, message: "Free tickets confirmed", tickets: freeTickets });
      }
      return res.status(404).json({ success: false, message: "Free tickets not found." });
    }

    const existingTickets = await Ticket.find({ paymentReference: new RegExp(`^${reference}`) });
    if (existingTickets.length > 0) {
      return res.status(200).json({ success: true, message: "Already verified", tickets: existingTickets });
    }

    const paystackVerify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });

    const txData = paystackVerify.data.data;
    if (txData.status !== 'success') return res.status(400).json({ success: false, message: "Payment verification failed." });

    const { buyerId, eventId, ticketType, quantity, attendees } = txData.metadata;
    const buyerEmail = txData.customer.email;

    const reCheckedTickets = await Ticket.find({ paymentReference: new RegExp(`^${reference}`) });
    if (reCheckedTickets.length > 0) {
      return res.status(200).json({ success: true, message: "Already verified", tickets: reCheckedTickets });
    }

    let finalBuyerId = buyerId;
    if (!finalBuyerId) {
      let guestUser = await User.findOne({ email: buyerEmail });
      if (!guestUser) {
        const randomPassword = crypto.randomBytes(8).toString('hex');
        guestUser = await User.create({
          name: txData.customer.first_name || attendees[0]?.firstName || 'Guest User',
          email: buyerEmail,
          password: randomPassword,
          role: 'user'
        });
      }
      finalBuyerId = guestUser._id;
    }

    const event = await Event.findById(eventId);
    const tier = event.tickets.find(t => t.name === ticketType);
    
    tier.sold += Number(quantity);
    event.eventTicketsSold = (event.eventTicketsSold || 0) + Number(quantity);
    event.eventRevenue = (event.eventRevenue || 0) + (txData.amount / 100); 
    await event.save();

    const ticketsToCreate = [];
    const ticketPrice = tier.price;
    const platformFee = ticketPrice * 0.07;
    const totalAmount = ticketPrice + platformFee;

    for (let i = 0; i < attendees.length; i++) {
      const attendee = attendees[i];
      const uniqueCode = `${reference}-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${i + 1}`;
      
      const qrCodeDataUrl = await qrcode.toDataURL(uniqueCode);
      const base64Image = qrCodeDataUrl.split(';base64,').pop(); 
      const recipientEmail = attendee.email || attendees[0].email; 

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
        paymentReference: `${reference}-${i}`,     
        attendee: {
          firstName: attendee.firstName || attendees[0].firstName,
          lastName: attendee.lastName || attendees[0].lastName,
          email: recipientEmail,
          phone: attendee.phone || attendees[0].phone
        },
        _base64: base64Image,
        _recipientEmail: recipientEmail
      });
    }

    const dbTickets = ticketsToCreate.map(({ _base64, _recipientEmail, ...rest }) => rest);
    const savedTickets = await Ticket.insertMany(dbTickets);

    // ✅ FIX: Await email sending BEFORE sending response so Render doesn't kill it
    try {
      const transporter = createTransporter();
      for (let i = 0; i < ticketsToCreate.length; i++) {
        const ticket = ticketsToCreate[i];
        const safeEmail = ticket._recipientEmail ? String(ticket._recipientEmail).trim() : null;
        if (!safeEmail) continue;

        await transporter.sendMail({
          from: '"Tickora Events" <no-reply@tickora.com>',
          to: safeEmail,
          subject: `Ticket Confirmed: ${event.title} (${ticket.ticketCode})`,
          html: `
            <div style="font-family: 'Space Grotesk', sans-serif; padding: 20px; text-align: center; background: #f9f9f9;">
              <h2 style="color: #ff5a36;">You're going to ${event.title}!</h2>
              <p>Hi <strong>${ticket.attendee.firstName}</strong>,</p>
              <p>Your payment was successful. Please present the QR code below at the gate for entry.</p>
              <div style="margin: 30px 0;">
                <img src="cid:ticket-qr-${i}" alt="Ticket QR Code" style="width: 200px; height: 200px; border-radius: 10px; border: 2px solid #ddd;" />
              </div>
              <div style="background: white; padding: 15px; border-radius: 10px; display: inline-block; text-align: left; border: 1px solid #eee;">
                <p style="margin: 5px 0;"><strong>Ticket Type:</strong> ${ticket.ticketType}</p>
                <p style="margin: 5px 0;"><strong>Ticket Code:</strong> ${ticket.ticketCode}</p>
              </div>
            </div>
          `,
          attachments: [
            { filename: `inline-qr-${ticket.ticketCode}.png`, content: ticket._base64, encoding: 'base64', cid: `ticket-qr-${i}` },
            { filename: `Download-Ticket-${ticket.ticketCode}.png`, content: ticket._base64, encoding: 'base64', contentType: 'image/png', disposition: 'attachment' }
          ]
        });
        console.log(`Paid ticket successfully sent to ${safeEmail}`);
      }
    } catch (err) {
      console.error(`Paid ticket email error for ${safeEmail}: ${err.message}`);
    }

    // ✅ FIX: Send response AFTER emails are safely sent
    return res.status(200).json({ success: true, message: "Tickets generated successfully", tickets: savedTickets });

  } catch (error) {
    console.error("Verification error:", error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: "Server error during payment verification." });
    }
  }
};

// ==========================================
// GET MY TICKETS (Buyer)
// ==========================================
export const getMyTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find({ buyer: req.user._id })
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

    const isBuyer = ticket.buyer._id.toString() === req.user._id.toString();
    const isOrganizer = ticket.organizer._id.toString() === req.user._id.toString();

    if (!isBuyer && !isOrganizer) {
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

    const holderName = ticket.attendee ? `${ticket.attendee.firstName} ${ticket.attendee.lastName}` : ticket.buyer?.name;
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
