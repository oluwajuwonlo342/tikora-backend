import express from 'express';
import { 
  initializePurchase, 
  verifyPurchase,
  getMyTickets,
  getTicketById,
  verifyAndCheckInTicket 
} from '../controllers/ticketController.js';

import protect, { optionalProtect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Purchase routes
router.post('/purchase/initialize', optionalProtect, initializePurchase);
// ✅ ADDED optionalProtect HERE:
router.post('/purchase/verify', optionalProtect, verifyPurchase);

// Dedicated Scanner Route
router.post('/scan', protect, verifyAndCheckInTicket);

// Ticket Retrieval routes
router.get('/my-tickets', protect, getMyTickets);
router.get('/:id', protect, getTicketById);

export default router;