import express from 'express';
import protect, { admin } from '../middleware/authMiddleware.js';
import {
  requestPayout,
  getOrganizerPayouts,
  verifyBankAccount,
  getBanks,                // Live Paystack bank list
  getAllPayouts,
  approvePayout,
  getPayoutBalance,        // One event's balance (organizer form)
  getMyEventBalances,      // All of an organizer's event balances (Wallet, Dashboard)
  getAllEventBalances,     // Every event's balance (admin table)
  getPendingPayoutSummary  // NEW: powers the admin pop-up, badge and banner
} from '../controllers/payoutController.js';
import { rejectPayout } from '../controllers/rejectPayoutController.js';

const router = express.Router();

// ORGANIZER ROUTES
router.get('/banks', getBanks); // Public: used by the payout request form's bank dropdown
router.post('/verify-bank', protect, verifyBankAccount);
router.post('/request', protect, requestPayout);
router.get('/my-payouts', protect, getOrganizerPayouts);
router.get('/balance/:eventId', protect, getPayoutBalance);
router.get('/my-balances', protect, getMyEventBalances);

// ADMIN ROUTES
router.get('/admin/all', protect, admin, getAllPayouts);
router.get('/admin/pending-summary', protect, admin, getPendingPayoutSummary); // NEW
router.get('/admin/event-balances', protect, admin, getAllEventBalances);
router.post('/admin/approve/:id', protect, admin, approvePayout);
router.post('/admin/reject/:id', protect, admin, rejectPayout);

export default router;