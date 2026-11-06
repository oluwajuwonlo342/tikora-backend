import express from "express";
import multer from "multer";

import {
  createEvent,
  getEvents,
  getEventById,
  getMyEvents,
  updateEvent,
  deleteEvent,
  getOrganizerStats,
  addAuthenticator,
  getEventAttendees,
  sendBulkEmailToAttendees,
} from "../controllers/eventController.js";

import protect from "../middleware/authMiddleware.js";
import { organizerOnly } from "../middleware/roleMiddleware.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

// ==========================================
// PUBLIC EVENTS
// ==========================================

router.get("/", getEvents);

// ==========================================
// ORGANIZER EVENTS
// ==========================================

// IMPORTANT:
// /my-events MUST come before /:id
router.get(
  "/my-events",
  protect,
  organizerOnly,
  getMyEvents
);

router.get('/organizer/stats', protect, getOrganizerStats);

// ==========================================
// EVENT MANAGEMENT (ATTENDEES & EMAILS)
// ==========================================

router.get(
  '/:id/attendees', 
  protect, 
  getEventAttendees
);

router.post(
  '/:id/send-email', 
  protect, 
  sendBulkEmailToAttendees
);

// ==========================================
// ADD AUTHENTICATOR
// ==========================================

router.post(
  "/:id/authenticator", 
  protect, 
  organizerOnly, 
  addAuthenticator
);

// ==========================================
// SINGLE EVENT
// ==========================================

router.get("/:id", getEventById);

// ==========================================
// CREATE EVENT
// ==========================================

router.post(
  "/",
  protect,
  organizerOnly,
  upload.single("image"),
  createEvent
);

// ==========================================
// UPDATE EVENT
// ==========================================

router.put(
  "/:id",
  protect,
  organizerOnly,
  upload.single("image"),
  updateEvent
);

// ==========================================
// DELETE EVENT
// ==========================================

router.delete(
  "/:id",
  protect,
  organizerOnly,
  deleteEvent
);

export default router;
