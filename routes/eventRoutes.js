import express from "express";
import multer from "multer";

import {
  createEvent,
  getEvents,
  getEventById,
  getMyEvents,
  updateEvent,
  deleteEvent,
} from "../controllers/eventController.js";

import protect from "../middleware/authMiddleware.js";
import { organizerOnly } from "../middleware/roleMiddleware.js";
import { getOrganizerStats, addAuthenticator } from '../controllers/eventController.js';


// Place this BEFORE dynamic routes like /:id to prevent route collision


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