import mongoose from "mongoose";
import Event from "../models/Event.js";
import cloudinary from "../config/cloudinary.js";

// Interpret datetime-local values as Nigerian time.
// Explicit ISO timestamps with Z or a timezone offset remain unchanged.
const parseEventDate = (value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const input = String(value).trim();

  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input);

  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)
    ? `${input}:00`
    : input;

  const parsed = new Date(
    hasTimezone ? normalized : `${normalized}+01:00`
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseTickets = (tickets) => {
  if (
    tickets === undefined ||
    tickets === null ||
    tickets === ""
  ) {
    return null;
  }

  return typeof tickets === "string"
    ? JSON.parse(tickets)
    : tickets;
};

const uploadImage = (file) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "event-ticketing/events",
        resource_type: "image",
      },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      }
    );

    stream.end(file.buffer);
  });

const validateTickets = (tickets, preserveSold = false) => {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error("At least one ticket type is required.");
  }

  return tickets.map((ticket) => {
    const name = String(ticket.name || "").trim();
    const price = Number(ticket.price);
    const quantity = Number(ticket.quantity);
    const sold = preserveSold ? Number(ticket.sold || 0) : 0;

    if (!name) {
      throw new Error("Ticket name is required.");
    }

    if (!Number.isFinite(price) || price < 0) {
      throw new Error("Invalid ticket price.");
    }

    if (!Number.isFinite(quantity) || quantity < 1) {
      throw new Error("Invalid ticket quantity.");
    }

    if (!Number.isFinite(sold) || sold < 0) {
      throw new Error("Invalid tickets-sold value.");
    }

    if (quantity < sold) {
      throw new Error(
        `Ticket quantity cannot be less than tickets already sold for "${name}".`
      );
    }

    return {
      ...(ticket._id ? { _id: ticket._id } : {}),
      name,
      price,
      quantity,
      sold,
    };
  });
};

// ==========================================
// CREATE EVENT
// ==========================================

export const createEvent = async (req, res) => {
  let uploadedImage;

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

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "User authentication is required.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Event image is required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(req.user._id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid organizer ID.",
      });
    }

    const parsedDate = parseEventDate(date);
    const parsedEndDate = endDate
      ? parseEventDate(endDate)
      : null;

    if (!parsedDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid event start date or time.",
      });
    }

    if (endDate && !parsedEndDate) {
      return res.status(400).json({
        success: false,
        message: "Invalid event end date or time.",
      });
    }

    if (parsedEndDate && parsedEndDate <= parsedDate) {
      return res.status(400).json({
        success: false,
        message: "End date must be after the event start date.",
      });
    }

    let parsedTickets;

    try {
      parsedTickets = parseTickets(tickets);
    } catch {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket data.",
      });
    }

    let cleanedTickets;

    try {
      cleanedTickets = validateTickets(parsedTickets);
    } catch (ticketError) {
      return res.status(400).json({
        success: false,
        message: ticketError.message,
      });
    }

    uploadedImage = await uploadImage(req.file);

    const event = await Event.create({
      title: title.trim(),
      description: description.trim(),
      category: category.toLowerCase(),
      date: parsedDate,
      endDate: parsedEndDate,
      location: location.trim(),
      venue: venue.trim(),

      image: uploadedImage.secure_url,
      imagePublicId: uploadedImage.public_id,

      organizer: req.user._id,
      tickets: cleanedTickets,
      status: "published",
    });

    return res.status(201).json({
      success: true,
      message: "Event created successfully.",
      event,
    });
  } catch (error) {
    console.error("CREATE EVENT ERROR:", error);

    if (uploadedImage?.public_id) {
      try {
        await cloudinary.uploader.destroy(uploadedImage.public_id);
      } catch (cleanupError) {
        console.error("Cloudinary cleanup error:", cleanupError);
      }
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Unable to create event.",
    });
  }
};

// ==========================================
// GET ALL PUBLISHED EVENTS
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
      const safeSearch = String(search).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      filter.$or = [
        {
          title: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          location: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          venue: {
            $regex: safeSearch,
            $options: "i",
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    const event = await Event.findById(req.params.id).populate(
      "organizer",
      "name avatar email"
    );

    if (!event) {
      return res.status(404).json({
        success: false,
        message: "Event not found.",
      });
    }

    event.views = (event.views || 0) + 1;

    await event.save();

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

// ==========================================
// GET EVENTS OWNED BY THE SIGNED-IN ORGANIZER
// ==========================================

export const getMyEvents = async (req, res) => {
  try {
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
// Only one updateEvent export should exist.
// ==========================================

export const updateEvent = async (req, res) => {
  let uploadedImage;

  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
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
      event.title = String(title).trim();
    }

    if (description !== undefined) {
      event.description = String(description).trim();
    }

    if (category !== undefined) {
      event.category = String(category).toLowerCase();
    }

    if (location !== undefined) {
      event.location = String(location).trim();
    }

    if (venue !== undefined) {
      event.venue = String(venue).trim();
    }

    if (status !== undefined) {
      event.status = status;
    }

    if (date !== undefined) {
      const parsedDate = parseEventDate(date);

      if (!parsedDate) {
        return res.status(400).json({
          success: false,
          message: "Invalid event start date or time.",
        });
      }

      event.date = parsedDate;
    }

    // An empty endDate means the organizer intentionally cleared it.
    if (endDate !== undefined) {
      if (endDate === "" || endDate === null) {
        event.endDate = null;
      } else {
        const parsedEndDate = parseEventDate(endDate);

        if (!parsedEndDate) {
          return res.status(400).json({
            success: false,
            message: "Invalid event end date or time.",
          });
        }

        event.endDate = parsedEndDate;
      }
    }

    if (
      event.endDate &&
      event.date &&
      new Date(event.endDate) <= new Date(event.date)
    ) {
      return res.status(400).json({
        success: false,
        message: "End date must be after the event start date.",
      });
    }

    if (tickets !== undefined) {
      let parsedTickets;

      try {
        parsedTickets = parseTickets(tickets);
      } catch {
        return res.status(400).json({
          success: false,
          message: "Invalid ticket data.",
        });
      }

      try {
        event.tickets = validateTickets(parsedTickets, true);
      } catch (ticketError) {
        return res.status(400).json({
          success: false,
          message: ticketError.message,
        });
      }
    }

    let oldPublicId = null;

    if (req.file) {
      uploadedImage = await uploadImage(req.file);

      oldPublicId = event.imagePublicId;

      event.image = uploadedImage.secure_url;
      event.imagePublicId = uploadedImage.public_id;
    }

    await event.save();

    // Delete the old image only after the database save succeeds.
    if (req.file && oldPublicId) {
      try {
        await cloudinary.uploader.destroy(oldPublicId);
      } catch (deleteError) {
        console.error(
          "Unable to delete old Cloudinary image:",
          deleteError
        );
      }
    }

    const updatedEvent = await Event.findById(event._id).populate(
      "organizer",
      "name avatar email"
    );

    return res.status(200).json({
      success: true,
      message: "Event updated successfully.",
      event: updatedEvent,
    });
  } catch (error) {
    console.error("Update event error:", error);

    if (uploadedImage?.public_id) {
      try {
        await cloudinary.uploader.destroy(uploadedImage.public_id);
      } catch (cleanupError) {
        console.error("Cloudinary cleanup error:", cleanupError);
      }
    }

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

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid event ID.",
      });
    }

    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required.",
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

    await Event.findByIdAndDelete(id);

    if (event.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(event.imagePublicId);
      } catch (cloudinaryError) {
        console.error(
          "Unable to delete Cloudinary image:",
          cloudinaryError
        );
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
      error: error.message,
    });
  }
};
