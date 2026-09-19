import mongoose from "mongoose";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js"; 
import Payout from "../models/Payout.js";
import cloudinary from "../config/cloudinary.js";

// ==========================================
// EMAIL HELPERS (Brevo HTTP API - works on Render, no SMTP ports needed)
// ==========================================
const sendBrevoEmail = async ({ to, toName, subject, html }) => {
  if (!process.env.BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is not set.");
  }

  const senderEmail = process.env.EMAIL_FROM;
  if (!senderEmail) {
    throw new Error("EMAIL_FROM is not set.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { name: "Tickora Scanner Auth", email: senderEmail },
        to: [{ email: to, name: toName }],
        subject,
        htmlContent: html,
      }),
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

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isValidEmail = (email) =>
  typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

// ==========================================
// CREATE EVENT
// ==========================================
export const createEvent = async (req, res) => {
  try {
    console.log("========== CREATE EVENT ==========");
    console.log("User:", req.user?._id);
    console.log("Body:", req.body);
    console.log("File:", req.file?.originalname);

    const {
      title,
      description,
      category,
      date,
      endDate,
      location,
      venue,
      tickets,
    } = req.body;

    // Validate required fields
    if (
      !title ||
      !description ||
      !category ||
      !date ||
      !location ||
      !venue
    ) {
      return res.status(400).json({
        success: false,
        message: "Please fill all required fields.",
      });
    }

    // Validate authenticated user
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "User authentication is required.",
      });
    }

    // Validate image
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Event image is required.",
      });
    }

    // Validate organizer ID
    if (!mongoose.Types.ObjectId.isValid(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid organizer ID.",
      });
    }

    // Upload image to Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "event-ticketing/events",
          resource_type: "image",
        },
        (error, result) => {
          if (error) {
            console.error("Cloudinary upload error:", error);
            reject(error);
          } else {
            resolve(result);
          }
        }
      );

      stream.end(req.file.buffer);
    });

    console.log("Cloudinary upload successful:");
    console.log(uploadResult.secure_url);

    // Parse tickets
    let parsedTickets = [];

    if (tickets) {
      try {
        parsedTickets =
          typeof tickets === "string"
            ? JSON.parse(tickets)
            : tickets;
      } catch (ticketError) {
        console.error("Ticket parsing error:", ticketError);

        return res.status(400).json({
          success: false,
          message: "Invalid ticket data.",
        });
      }
    }

    // Make sure there is at least one ticket
    if (!Array.isArray(parsedTickets) || parsedTickets.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one ticket type is required.",
      });
    }

    // Validate tickets
    const cleanedTickets = parsedTickets.map((ticket) => ({
      name: String(ticket.name || "").trim(),
      price: Number(ticket.price),
      quantity: Number(ticket.quantity),
    }));

    for (const ticket of cleanedTickets) {
      if (!ticket.name) {
        return res.status(400).json({
          success: false,
          message: "Ticket name is required.",
        });
      }

      if (Number.isNaN(ticket.price) || ticket.price < 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket price.",
        });
      }

      if (
        Number.isNaN(ticket.quantity) ||
        ticket.quantity < 1
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket quantity.",
        });
      }
    }

    // Create event in MongoDB
    const event = await Event.create({
      title: title.trim(),
      description: description.trim(),
      category: category.toLowerCase(),
      date: new Date(date),
      endDate: endDate ? new Date(endDate) : null,
      location: location.trim(),
      venue: venue.trim(),

      image: uploadResult.secure_url,
      imagePublicId: uploadResult.public_id,

      organizer: req.user._id,

      tickets: cleanedTickets,

      status: "published",
    });

    console.log("EVENT SAVED TO DATABASE:");
    console.log(event._id);

    return res.status(201).json({
      success: true,
      message: "Event created successfully.",
      event,
    });
  } catch (error) {
    console.error("================================");
    console.error("CREATE EVENT ERROR");
    console.error(error);
    console.error("================================");

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to create event.",
    });
  }
};

// ==========================================
// GET ALL EVENTS
// ==========================================
export const getEvents = async (req, res) => {
  try {
    const { category, search } = req.query;

    const filter = {
      status: "published",
    };

    if (category) {
      filter.category = category.toLowerCase();
    }

    if (search) {
      filter.$or = [
        {
          title: {
            $regex: search,$options: "i",
          },
        },
        {
          location: {
            $regex: search,$options: "i",
          },
        },
        {
          venue: {
            $regex: search,$options: "i",
          },
        },
      ];
    }

    const events = await Event.find(filter)
      .populate("organizer", "name avatar")
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("Get events error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch events.",
      error: error.message,
    });
  }
};

// ==========================================
// GET SINGLE EVENT
// ==========================================
export const getEventById = async (req, res) => {
  try {
    // Prevent "my-events" from being treated as an ObjectId
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true } 
    ).populate(
      "organizer",
      "name avatar email"
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    return res.json({
      success: true,
      event,
    });
  } catch (error) {
    console.error("Get event error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch event.",
      error: error.message,
    });
  }
};

export const getMyEvents = async (req, res) => {
  try {
    console.log("========== GET MY EVENTS ==========");
    console.log("User:", req.user?._id);

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const events = await Event.find({
      organizer: req.user._id,
    })
      .populate("organizer", "name avatar email")
      .sort({ createdAt: -1 });

    console.log("Events found:", events.length);

    return res.status(200).json({
      success: true,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("Get my events error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch your events.",
      error: error.message,
    });
  }
};

// ==========================================
// UPDATE EVENT
// ==========================================
export const updateEvent = async (req, res) => {
  try {
    const { id } = req.params;

    console.log("========== UPDATE EVENT ==========");
    console.log("Event ID:", id);
    console.log("User:", req.user?._id);
    console.log("Body:", req.body);
    console.log("File:", req.file?.originalname);
    console.log("================================");

    const event = await Event.findById(id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    // Make sure the organizer owns this event
    if (
      event.organizer.toString() !==
      req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message:
          "You are not authorized to edit this event.",
      });
    }

    const {
      title,
      description,
      category,
      date,
      endDate,
      location,
      venue,
      tickets,
      status,
    } = req.body;

    // Update basic fields only when supplied
    if (title !== undefined) {
      event.title = title;
    }

    if (description !== undefined) {
      event.description = description;
    }

    if (category !== undefined) {
      event.category = category;
    }

    if (date !== undefined) {
      event.date = date;
    }

    if (endDate !== undefined) {
      event.endDate = endDate;
    }

    if (location !== undefined) {
      event.location = location;
    }

    if (venue !== undefined) {
      event.venue = venue;
    }

    if (status !== undefined) {
      event.status = status;
    }

    // Parse tickets
    if (tickets !== undefined) {
      try {
        event.tickets =
          typeof tickets === "string"
            ? JSON.parse(tickets)
            : tickets;
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket data.",
        });
      }
    }

    // If a new image was uploaded
    if (req.file) {
      // Delete old image from Cloudinary
      if (event.imagePublicId) {
        try {
          await cloudinary.uploader.destroy(
            event.imagePublicId
          );
        } catch (cloudinaryError) {
          console.error(
            "Unable to delete old Cloudinary image:",
            cloudinaryError
          );
        }
      }

      // Upload new image
      const uploadResult = await new Promise(
        (resolve, reject) => {
          cloudinary.uploader
            .upload_stream(
              {
                folder: "event-ticketing/events",
              },
              (error, result) => {
                if (error) {
                  reject(error);
                } else {
                  resolve(result);
                }
              }
            )
            .end(req.file.buffer);
        }
      );

      event.image = uploadResult.secure_url;
      event.imagePublicId =
        uploadResult.public_id;
    }

    await event.save();

    return res.status(200).json({
      success: true,
      message: "Event updated successfully.",
      event,
    });
  } catch (error) {
    console.error(
      "Update event error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to update event.",
      error: error.message,
    });
  }
};

// ==========================================
// DELETE EVENT
// ==========================================
export const deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;

    console.log("========== DELETE EVENT ==========");
    console.log("Event ID:", id);
    console.log("User:", req.user?._id);
    console.log("================================");

    const event = await Event.findById(id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    // Make sure organizer owns the event
    if (
      event.organizer.toString() !==
      req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message:
          "You are not authorized to delete this event.",
      });
    }

    // Delete image from Cloudinary
    if (event.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(
          event.imagePublicId
        );
      } catch (cloudinaryError) {
        console.error(
          "Unable to delete Cloudinary image:",
          cloudinaryError
        );
      }
    }

    // Delete event from MongoDB
    await Event.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Event deleted successfully.",
    });
  } catch (error) {
    console.error(
      "Delete event error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to delete event.",
      error: error.message,
    });
  }
};

// ==========================================
// GET ORGANIZER DASHBOARD STATS & ANALYTICS
// ==========================================
export const getOrganizerStats = async (req, res) => {
  try {
    const organizerId = req.user._id;

    // 1. Fetch events
    const events = await Event.find({ organizer: organizerId });
    const eventIds = events.map(e => e._id);

    // 2. Fetch tickets and payouts (populated with event titles for the history logs)
    const tickets = await Ticket.find({ event: { $in: eventIds }, status: {$ne: 'cancelled' } })
      .populate('event', 'title')
      .sort({ createdAt: -1 });

    const payouts = await Payout.find({ event: { $in: eventIds } })
      .populate('event', 'title')
      .sort({ createdAt: -1 });

    // 3. Build Global Metrics
    const totalEvents = events.length;
    const totalTicketsSold = tickets.length;
    
    let totalGrossEarned = 0;
    let totalWithdrawn = 0;

    events.forEach(event => {
      event.tickets.forEach(tier => {
        totalGrossEarned += (tier.sold || 0) * (tier.price || 0);
      });
    });

    // Only deduct pending and approved payouts from the wallet balance
    const activePayouts = payouts.filter(p => p.status === 'pending' || p.status === 'approved');
    activePayouts.forEach(payout => {
      totalWithdrawn += payout.amount;
    });

    const availableTotalRevenue = totalGrossEarned - totalWithdrawn;

    // 4. Build Unified Transaction History (Money In vs Money Out)
    const transactions = [];

    // Add Ticket Sales (Credits)
    tickets.forEach(ticket => {
      if (ticket.ticketPrice > 0) {
        transactions.push({
          id: ticket._id,
          type: 'credit',
          amount: ticket.ticketPrice,
          date: ticket.createdAt,
          description: `Ticket Sale (${ticket.ticketType}): ${ticket.event?.title || 'Event'}`,
          status: 'completed'
        });
      }
    });

    // Add Payouts (Debits)
    payouts.forEach(payout => {
      transactions.push({
        id: payout._id,
        type: 'debit',
        amount: payout.amount,
        date: payout.createdAt,
        description: `Withdrawal: ${payout.event?.title || 'Event'}`,
        status: payout.status
      });
    });

    // Sort combined ledger by newest first
    transactions.sort((a, b) => b.date - a.date);

    // 5. Build event performance list
    const eventAnalytics = events.map(event => {
      let eventGross = 0;
      let eventTicketsSold = 0;
      let eventCapacity = 0;

      event.tickets.forEach(tier => {
        eventTicketsSold += (tier.sold || 0);
        eventCapacity += (tier.quantity || 0);
        eventGross += (tier.sold || 0) * (tier.price || 0);
      });

      const eventWithdrawn = activePayouts
        .filter(p => p.event?._id?.toString() === event._id.toString())
        .reduce((sum, p) => sum + p.amount, 0);

      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        venue: event.venue,
        image: event.image,
        category: event.category,
        eventTicketsSold,
        eventCapacity,
        eventRevenue: eventGross - eventWithdrawn 
      };
    });

    return res.status(200).json({
      success: true,
      stats: {
        totalEvents,
        totalTicketsSold,
        totalRevenue: availableTotalRevenue, 
        totalGrossEarned, 
        totalWithdrawn
      },
      events: eventAnalytics,
      // Send the top 50 most recent transactions to keep the payload fast
      transactions: transactions.slice(0, 50) 
    });

  } catch (error) {
    console.error("Organizer stats error:", error);
    return res.status(500).json({ success: false, message: "Server error fetching dashboard stats." });
  }
};

// ==========================================
// ADD TICKET AUTHENTICATOR (SCANNER INVITE)
// ==========================================
export const addAuthenticator = async (req, res) => {
  try {
    const { id: eventId } = req.params;
    const { name, email } = req.body;

    console.log(`========== ADD AUTHENTICATOR ==========`);
    console.log(`Event ID: ${eventId}, Invitee: ${email}`);

    // Validate input
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ success: false, message: "Invalid event ID." });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Authenticator name is required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "A valid email address is required." });
    }

    const cleanName = String(name).trim();
    const cleanEmail = email.trim().toLowerCase();

    const event = await Event.findById(eventId);
    if (!event) {
      console.log("Error: Event not found");
      return res.status(404).json({ success: false, message: "Event not found" });
    }

    // Make sure only the organizer can add staff
    if (event.organizer.toString() !== req.user._id.toString()) {
      console.log("Error: Unauthorized user tried to add authenticator");
      return res.status(403).json({ success: false, message: "Only the organizer can add authenticators." });
    }

    const clientUrl = (process.env.CLIENT_URL || 'https://tikora-backend.onrender.com').replace(/\/$/, '');
    const scannerLink = `${clientUrl}/organizer/scanner`;

    const html = `
        <div style="font-family: sans-serif; padding: 20px; background: #f9f9f9; text-align: center;">
          <h2 style="color: #ff5a36;">Ticket Authenticator Invitation</h2>
          <p>Hello <strong>${escapeHtml(cleanName)}</strong>,</p>
          <p>You have been invited to act as a ticket authenticator at the gate for <strong>${escapeHtml(event.title)}</strong>.</p>
          <div style="margin: 30px 0;">
            <a href="${scannerLink}" style="background: #ff5a36; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Open Ticket Scanner
            </a>
          </div>
          <p style="color: #777; font-size: 12px;">If you do not have an account, you will be prompted to create one first.</p>
        </div>
      `;

    // Send via Brevo HTTP API and WAIT for the result so we never report a false success
    try {
      const result = await sendBrevoEmail({
        to: cleanEmail,
        toName: cleanName,
        subject: `You've been invited to scan tickets for: ${event.title}`,
        html,
      });

      console.log(`✅ Scanner invite accepted by Brevo for ${cleanEmail}. Message ID: ${result.messageId}`);
    } catch (mailError) {
      console.error("❌ Scanner invite failed to send:", mailError.message);
      return res.status(502).json({
        success: false,
        message: "Could not send the invitation email. Please try again later.",
      });
    }

    return res.status(200).json({
      success: true,
      message: `Invitation sent to ${cleanEmail} successfully!`,
    });
  } catch (error) {
    console.error("Add authenticator error:", error);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: "Failed to process invitation." });
    }
  }
};
