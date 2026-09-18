import express from 'express';
import protect, { admin } from '../middleware/authMiddleware.js';
import { getDashboardStats, getAllUsers, getAllEvents } from '../controllers/adminController.js';

const router = express.Router();

// Apply the protect and admin middleware to EVERYTHING in this file
router.use(protect, admin);

router.get('/stats', getDashboardStats);
router.get('/users', getAllUsers);
router.get('/events', getAllEvents);

export default router;