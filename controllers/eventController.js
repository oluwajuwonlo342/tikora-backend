
import mongoose from "mongoose";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Payout from "../models/Payout.js";
import cloudinary from "../config/cloudinary.js";

// ==========================================
// EMAIL HELPERS - BREVO HTTP API
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
        accept: "application/json",
        "content-type": "application/json",
        "api-key": process.env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: {
          name: "Tikora Scanner Auth",
          email: senderEmail,
        },
        to: [{ email: to, name: toName }],
        subject,
        htmlContent: html,
      }),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `Brevo API ${response.status}: ${
          data.message || JSON.stringify(data)
        }`
      );
    }

    return data;
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
  typeof email === "string" &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

const isValidObjectId = (id) =>
  typeof id === "string" && mongoose.Types.ObjectId.isValid(id);

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const uploadEventImage = (file) =>
  new Promise((resolve, reject) => {
    if (!file?.buffer) {
      reject(new Error("A valid image file is required."));
      return;
    }

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "event-ticketing/events",
        resource_type: "image",
      },
      (error, result) => {
        if (error) return reject(error);

        if (!result?.secure_url) {
          return reject(new Error("Cloudinary did not return an image URL."));
        }

        resolve(result);
      }
    );

    stream.end(file.buffer);
  });

const parseTickets = (tickets) => {
  let parsed = tickets;

  if (typeof tickets === "string") {
    try {
      parsed = JSON.parse(tickets);
    } catch {
      throw new Error("Invalid ticket data.");
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("At least one ticket type is required.");
  }

  return parsed.map((ticket) => {
    const name = String(ticket?.name || "").trim();
    const price = Number(ticket?.price);
    const quantity = Number(ticket?.quantity);

    if (!name) {
      throw new Error("Ticket name is required.");
    }

    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid ticket price for "${name}".`);
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error(`Ticket quantity for "${name}" must be a positive whole number.`);
    }

    return { ...ticket, name, price, quantity };
  });
};

// ==========================================
// CREATE EVENT
// ==========================================

export const createEvent = async (req, res) => {
  let uploadedImagePublicId;

  try {
    console.log("========== CREATE EVENT ==========");
    console.log("User:", req.user?._id);
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

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "User authentication is required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(req.user._id))) {
      return res.status(400).json({
        success: false,
        message: "Invalid organizer ID.",
      });
    }

    if (
      !title?.trim() ||
      !description?.trim() ||
      !category?.trim() ||
      !date ||
      !location?.trim() ||
      !venue?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please fill all required fields.",
      });
    }

    const eventDate = new Date(date);
    const eventEndDate = endDate ? new Date(endDate) : null;

    if (Number.isNaN(eventDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid event date.",
      });
    }

    if (endDate && Number.isNaN(eventEndDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid event end date.",
      });
    }

    if (eventEndDate && eventEndDate < eventDate) {
      return res.status(400).json({
        success: false,
        message: "Event end date cannot be before its start date.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Event image is required.",
      });
    }

    let cleanedTickets;

    try {
      cleanedTickets = parseTickets(tickets);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    // Upload only after validating the submitted event and tickets.
    const uploadResult = await uploadEventImage(req.file);
    uploadedImagePublicId = uploadResult.public_id;

    const event = await Event.create({
      title: title.trim(),
      description: description.trim(),
      category: category.trim().toLowerCase(),
      date: eventDate,
      endDate: eventEndDate,
      location: location.trim(),
      venue: venue.trim(),
      image: uploadResult.secure_url,
      imagePublicId: uploadResult.public_id,
      organizer: req.user._id,
      tickets: cleanedTickets,
      status: "published",
    });

    console.log("Event saved:", event._id);

    return res.status(201).json({
      success: true,
      message: "Event created successfully.",
      event,
    });
  } catch (error) {
    console.error("Create event error:", error);

    // Avoid leaving an uploaded image behind if database creation fails.
    if (uploadedImagePublicId) {
      try {
        await cloudinary.uploader.destroy(uploadedImagePublicId);
      } catch (cleanupError) {
        console.error("Cloudinary cleanup failed:", cleanupError.message);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Unable to create event.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};

// ==========================================
// GET ALL PUBLISHED EVENTS
// ==========================================

export const getEvents = async (req, res) => {
  try {
    const { category, search } = req.query;

    const filter = { status: "published" };

    if (category?.trim()) {
      filter.category = category.trim().toLowerCase();
    }

    if (search?.trim()) {
      const searchRegex = new RegExp(escapeRegex(search.trim()), "i");

      filter.$or = [
        { title: searchRegex },
        { location: searchRegex },
        { venue: searchRegex },
      ];
    }

    const events = await Event.find(filter)
      .populate("organizer", "name avatar")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("Get events error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch events.",
    });
  }
};

// ==========================================
// GET SINGLE EVENT
// ==========================================

export const getEventById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    const event = await Event.findOneAndUpdate(
      { _id: id, status: "published" },
      { $inc: { views: 1 } },
      { new: true, runValidators: true }
    ).populate("organizer", "name avatar email");

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    return res.status(200).json({
      success: true,
      event,
    });
  } catch (error) {
    console.error("Get event error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch event.",
    });
  }
};

// ==========================================
// GET ORGANIZER'S EVENTS
// ==========================================

export const getMyEvents = async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const events = await Event.find({ organizer: req.user._id })
      .populate("organizer", "name avatar email")
      .sort({ createdAt: -1 });

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
    });
  }
};

// ==========================================
// UPDATE EVENT
// ==========================================

export const updateEvent = async (req, res) => {
  let uploadedImagePublicId;

  try {
    const { id } = req.params;

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    const event = await Event.findById(id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to edit this event.",
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

    if (title !== undefined) {
      if (!String(title).trim()) {
        return res.status(400).json({
          success: false,
          message: "Event title cannot be empty.",
        });
      }
      event.title = String(title).trim();
    }

    if (description !== undefined) {
      if (!String(description).trim()) {
        return res.status(400).json({
          success: false,
          message: "Event description cannot be empty.",
        });
      }
      event.description = String(description).trim();
    }

    if (category !== undefined) {
      event.category = String(category).trim().toLowerCase();
    }

    if (date !== undefined) {
      const parsedDate = new Date(date);

      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid event date.",
        });
      }

      event.date = parsedDate;
    }

    if (endDate !== undefined) {
      if (endDate === "") {
        event.endDate = null;
      } else {
        const parsedEndDate = new Date(endDate);

        if (Number.isNaN(parsedEndDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid event end date.",
          });
        }

        event.endDate = parsedEndDate;
      }
    }

    if (event.endDate && event.date && event.endDate < event.date) {
      return res.status(400).json({
        success: false,
        message: "Event end date cannot be before its start date.",
      });
    }

    if (location !== undefined) event.location = String(location).trim();
    if (venue !== undefined) event.venue = String(venue).trim();

    // Only allow recognized statuses.
    if (status !== undefined) {
      const allowedStatuses = ["draft", "published", "cancelled"];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid event status.",
        });
      }

      event.status = status;
    }

    if (tickets !== undefined) {
      try {
        event.tickets = parseTickets(tickets);
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }
    }

    if (req.file) {
      const uploadResult = await uploadEventImage(req.file);
      uploadedImagePublicId = uploadResult.public_id;

      const oldImagePublicId = event.imagePublicId;

      event.image = uploadResult.secure_url;
      event.imagePublicId = uploadResult.public_id;

      await event.save();

      // Remove old image only after the updated event has been saved.
      if (oldImagePublicId) {
        try {
          await cloudinary.uploader.destroy(oldImagePublicId);
        } catch (cleanupError) {
          console.error("Old image cleanup failed:", cleanupError.message);
        }
      }

      return res.status(200).json({
        success: true,
        message: "Event updated successfully.",
        event,
      });
    }

    await event.save();

    return res.status(200).json({
      success: true,
      message: "Event updated successfully.",
      event,
    });
  } catch (error) {
    console.error("Update event error:", error);

    if (uploadedImagePublicId) {
      try {
        await cloudinary.uploader.destroy(uploadedImagePublicId);
      } catch (cleanupError) {
        console.error("Image cleanup failed:", cleanupError.message);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Unable to update event.",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
};

// ==========================================
// DELETE EVENT
// ==========================================

export const deleteEvent = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    const event = await Event.findById(id);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to delete this event.",
      });
    }

    // Do not automatically delete tickets or payout history here.
    // Those records may be needed for refunds, reconciliation, and audits.
    await Event.findByIdAndDelete(id);

    if (event.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(event.imagePublicId);
      } catch (cloudinaryError) {
        console.error("Cloudinary image deletion failed:", cloudinaryError.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Event deleted successfully.",
    });
  } catch (error) {
    console.error("Delete event error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to delete event.",
    });
  }
};

// ==========================================
// ORGANIZER DASHBOARD STATS & ANALYTICS
// ==========================================

export const getOrganizerStats = async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    const organizerId = req.user._id;

    const events = await Event.find({ organizer: organizerId }).sort({
      createdAt: -1,
    });

    const eventIds = events.map((event) => event._id);

    const [tickets, payouts] = await Promise.all([
      Ticket.find({
        event: { $in: eventIds },
        status: { $ne: "cancelled" },
      })
        .populate("event", "title")
        .sort({ createdAt: -1 }),

      Payout.find({ event: { $in: eventIds } })
        .populate("event", "title")
        .sort({ createdAt: -1 }),
    ]);

    const totalEvents = events.length;

    // This assumes each Ticket document represents one sold ticket.
    const totalTicketsSold = tickets.length;

    let totalGrossEarned = 0;

    for (const event of events) {
      for (const tier of event.tickets || []) {
        totalGrossEarned +=
          (Number(tier.sold) || 0) * (Number(tier.price) || 0);
      }
    }

    // These are payouts still pending or approved, not necessarily completed
    // withdrawals. Completed payouts should be accounted for according to
    // your wallet's actual balance/settlement rules.
    const activePayouts = payouts.filter((payout) =>
      ["pending", "approved"].includes(payout.status)
    );

    const totalActivePayouts = activePayouts.reduce(
      (sum, payout) => sum + (Number(payout.amount) || 0),
      0
    );

    const availableTotalRevenue = totalGrossEarned - totalActivePayouts;

    // Unified transaction history.
    const transactions = [];

    for (const ticket of tickets) {
      const amount = Number(ticket.ticketPrice) || 0;

      if (amount > 0) {
        transactions.push({
          id: ticket._id,
          type: "credit",
          amount,
          date: ticket.createdAt,
          description: `Ticket Sale (${ticket.ticketType || "Ticket"}): ${
            ticket.event?.title || "Event"
          }`,
          status: "completed",
        });
      }
    }

    for (const payout of payouts) {
      transactions.push({
        id: payout._id,
        type: "debit",
        amount: Number(payout.amount) || 0,
        date: payout.createdAt,
        description: `Withdrawal: ${payout.event?.title || "Event"}`,
        status: payout.status,
      });
    }

    transactions.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    // Event-level performance.
    const eventAnalytics = events.map((event) => {
      let eventGross = 0;
      let eventTicketsSold = 0;
      let eventCapacity = 0;

      for (const tier of event.tickets || []) {
        eventTicketsSold += Number(tier.sold) || 0;
        eventCapacity += Number(tier.quantity) || 0;
        eventGross +=
          (Number(tier.sold) || 0) * (Number(tier.price) || 0);
      }

      const eventActivePayouts = activePayouts
        .filter(
          (payout) =>
            payout.event?._id?.toString() === event._id.toString()
        )
        .reduce((sum, payout) => sum + (Number(payout.amount) || 0), 0);

      return {
        _id: event._id,
        title: event.title,
        date: event.date,
        venue: event.venue,
        location: event.location,
        image: event.image,
        category: event.category,
        status: event.status,
        eventTicketsSold,
        eventCapacity,
        eventRevenue: eventGross - eventActivePayouts,
      };
    });

    return res.status(200).json({
      success: true,
      stats: {
        totalEvents,
        totalTicketsSold,
        totalRevenue: availableTotalRevenue,
        totalGrossEarned,
        totalWithdrawn: totalActivePayouts,
      },
      events: eventAnalytics,
      transactions: transactions.slice(0, 200),
    });
  } catch (error) {
    console.error("Organizer stats error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error fetching dashboard stats.",
    });
  }
};

// ==========================================
// ADD TICKET AUTHENTICATOR - SCANNER INVITE
// ==========================================

export const addAuthenticator = async (req, res) => {
  try {
    const { id: eventId } = req.params;
    const { name, email } = req.body;

    console.log("========== ADD AUTHENTICATOR ==========");
    console.log(`Event ID: ${eventId}, Invitee: ${email}`);

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
      });
    }

    if (!isValidObjectId(eventId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Authenticator name is required.",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "A valid email address is required.",
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail = email.trim().toLowerCase();

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Only the organizer can add authenticators.",
      });
    }

    // CLIENT_URL must be your deployed frontend URL, not your backend URL.
    const clientUrl = (
      process.env.CLIENT_URL || "https://tikora.onrender.com"
    ).replace(/\/+$/, "");

    const scannerLink = `${clientUrl}/organizer/scanner`;

    const html = `
      <div style="font-family:Arial,sans-serif;padding:24px;background:#f9f9f9;">
        <div style="max-width:560px;margin:auto;background:#fff;padding:24px;border-radius:12px;">
          <h2 style="color:#ff5a36;">Ticket Authenticator Invitation</h2>
          <p>Hello <strong>${escapeHtml(cleanName)}</strong>,</p>
          <p>
            You have been invited to act as a ticket authenticator at the gate
            for <strong>${escapeHtml(event.title)}</strong>.
          </p>
          <p style="margin:28px 0;">
            <a href="${escapeHtml(scannerLink)}"
              style="background:#ff5a36;color:white;padding:12px 24px;
              text-decoration:none;border-radius:8px;font-weight:bold;">
              Open Ticket Scanner
            </a>
          </p>
          <p style="color:#777;font-size:12px;">
            If you do not have an account, you may need to create one first.
          </p>
        </div>
      </div>
    `;

    try {
      const result = await sendBrevoEmail({
        to: cleanEmail,
        toName: cleanName,
        subject: `You've been invited to scan tickets for: ${event.title}`,
        html,
      });

      console.log(
        `Scanner invite accepted by Brevo for ${cleanEmail}. Message ID: ${
          result.messageId || "not provided"
        }`
      );
    } catch (mailError) {
      console.error("Scanner invite failed to send:", mailError.message);

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

    return res.status(500).json({
      success: false,
      message: "Failed to process invitation.",
    });
  }
};
