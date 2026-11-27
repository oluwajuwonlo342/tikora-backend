import express from 'express';
import protect, { admin } from '../middleware/authMiddleware.js';
import {
  getDashboardStats,
  getAllUsers,
  getAllEvents,
  setUserStatus
} from '../controllers/adminController.js';
import { previewRecipients, sendBroadcast } from '../controllers/adminEmailController.js';
import { deleteEventAsAdmin, setEventStatusAsAdmin } from '../controllers/adminEventController.js';

const router = express.Router();

// Apply the protect and admin middleware to EVERYTHING in this file
router.use(protect, admin);

// DASHBOARD
router.get('/stats', getDashboardStats);

// USERS
router.get('/users', getAllUsers);
router.patch('/users/:id/status', setUserStatus);        // Ban User / Restore User

// EVENTS
router.get('/events', getAllEvents);
router.delete('/events/:id', deleteEventAsAdmin);        // Delete (only if no tickets or payouts)
router.patch('/events/:id/status', setEventStatusAsAdmin); // Cancel / hide / publish

// EMAILS
router.post('/email/preview', previewRecipients);
router.post('/email/send', sendBroadcast);

export default router;
