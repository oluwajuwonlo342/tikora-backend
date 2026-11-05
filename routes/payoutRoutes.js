import express from 'express';
import protect, { admin } from '../middleware/authMiddleware.js';
import { 
  requestPayout, 
  getOrganizerPayouts, 
  verifyBankAccount,
  getBanks,           // <-- Live Paystack bank list
  getAllPayouts,      // <-- Make sure this is imported!
  approvePayout       // <-- Make sure this is imported!
} from '../controllers/payoutController.js';
  import { rejectPayout } from "../controllers/rejectPayoutController.js";

const router = express.Router();

// ORGANIZER ROUTES
router.get('/banks', getBanks); // Public: used by the payout request form's bank dropdown
router.post('/verify-bank', protect, verifyBankAccount);
router.post('/request', protect, requestPayout);
router.get('/my-payouts', protect, getOrganizerPayouts);

// ADMIN ROUTES (This is the one your frontend is looking for!)
router.get('/admin/all', protect, admin, getAllPayouts);
router.post('/admin/approve/:id', protect, admin, approvePayout);
 router.post("/admin/reject/:id", protect, admin, rejectPayout);

export default router;
