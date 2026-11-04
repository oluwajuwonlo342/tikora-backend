import express from 'express';
import protect, { admin } from '../middleware/authMiddleware.js';
import { getDashboardStats, getAllUsers, getAllEvents } from '../controllers/adminController.js';
import { previewRecipients, sendBroadcast } from "../controllers/adminEmailController.js";

router.post("/email/preview", /* your existing admin middleware */ previewRecipients);
router.post("/email/send", /* your existing admin middleware */ sendBroadcast);

const router = express.Router();

// Apply the protect and admin middleware to EVERYTHING in this file
router.use(protect, admin);

router.get('/stats', getDashboardStats);
router.get('/users', getAllUsers);
router.get('/events', getAllEvents);

export default router;
