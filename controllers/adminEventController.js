// controllers/adminEventController.js
//
// Admin tools for the Event Moderation tab:
//   DELETE /api/admin/events/:id          -> delete an event (only if it has no tickets or payouts)
//   PATCH  /api/admin/events/:id/status   -> publish, unpublish (draft) or cancel an event
//
// Both routes sit behind your existing protect + admin middleware.

import mongoose from "mongoose";
import Event from "../models/Event.js";
import Ticket from "../models/Ticket.js";
import Payout from "../models/Payout.js";
import cloudinary from "../config/cloudinary.js";

const isValidId = (id) => typeof id === "string" && mongoose.Types.ObjectId.isValid(id);

// ---------------------------------------------------------------
// DELETE /api/admin/events/:id
//
// An event with tickets or payout records can't be deleted: the tickets people
// bought and the money records would be left pointing at an event that no
// longer exists. For those, the admin is told to cancel (hide) the event instead.
// ---------------------------------------------------------------
export const deleteEventAsAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: "Invalid event ID." });
    }

    const event = await Event.findById(id);

    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    const [ticketCount, payoutCount] = await Promise.all([
      Ticket.countDocuments({ event: id }),
      Payout.countDocuments({ event: id }),
    ]);

    if (ticketCount > 0 || payoutCount > 0) {
      const reasons = [];
      if (ticketCount > 0) reasons.push(`${ticketCount} ticket${ticketCount === 1 ? "" : "s"}`);
      if (payoutCount > 0) reasons.push(`${payoutCount} payout record${payoutCount === 1 ? "" : "s"}`);

      return res.status(409).json({
        success: false,
        message: `This event has ${reasons.join(" and ")}, so it can't be deleted. Deleting it would break the tickets and payment records.`,
        ticketCount,
        payoutCount,
      });
    }

    await Event.findByIdAndDelete(id);

    // Remove the image from Cloudinary (a failure here must not undo the delete)
    if (event.imagePublicId) {
      try {
        await cloudinary.uploader.destroy(event.imagePublicId);
      } catch (cloudinaryError) {
        console.error("Cloudinary image deletion failed:", cloudinaryError.message);
      }
    }

    console.log(`Admin ${req.user?._id} deleted event ${id} ("${event.title}")`);

    return res.status(200).json({ success: true, message: "Event deleted successfully." });
  } catch (error) {
    console.error("Admin delete event error:", error);
    return res.status(500).json({ success: false, message: "Unable to delete event." });
  }
};

// ---------------------------------------------------------------
// PATCH /api/admin/events/:id/status   body: { status }
// "cancelled" and "draft" both hide the event from the public pages.
// ---------------------------------------------------------------
export const setEventStatusAsAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: "Invalid event ID." });
    }

    const allowedStatuses = ["draft", "published", "cancelled"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid event status." });
    }

    const event = await Event.findByIdAndUpdate(id, { status }, { new: true });

    if (!event) {
      return res.status(404).json({ success: false, message: "Event not found." });
    }

    console.log(`Admin ${req.user?._id} set event ${id} to ${status}`);

    return res.status(200).json({
      success: true,
      message: `Event is now ${status}.`,
      event: { _id: event._id, status: event.status },
    });
  } catch (error) {
    console.error("Admin set event status error:", error);
    return res.status(500).json({ success: false, message: "Unable to update the event." });
  }
};
