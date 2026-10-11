import Payout from '../models/Payout.js';
import Ticket from '../models/Ticket.js';
import Event from '../models/Event.js';
import axios from 'axios';

const PAYSTACK_BASE = 'https://api.paystack.co';
const paystackHeaders = {
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json'
};

// ==========================================
// VERIFY BANK ACCOUNT (Via Paystack)
// Still works on a Starter Business — resolving account names is allowed
// even though transferring money to them is not.
// ==========================================
export const verifyBankAccount = async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;

    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'Account number and bank code are required.' });
    }

    const response = await axios.get(`${PAYSTACK_BASE}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
      headers: paystackHeaders
    });

    return res.status(200).json({
      success: true,
      accountName: response.data.data.account_name,
      accountNumber: response.data.data.account_number
    });

  } catch (error) {
    console.error('Bank verification error:', error.response?.data || error.message);
    return res.status(400).json({ success: false, message: 'Could not verify bank account. Please check the details.' });
  }
};

// ==========================================
// REQUEST PAYOUT (Organizer)
// ==========================================
export const requestPayout = async (req, res) => {
  try {
    const { eventId, bankDetails, amountRequested } = req.body;

    if (!bankDetails?.accountNumber || !bankDetails?.bankCode || !bankDetails?.accountName) {
      return res.status(400).json({
        success: false,
        message: 'Bank details must include accountNumber, bankCode and accountName.'
      });
    }

    const amount = Number(amountRequested);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid payout amount.' });
    }

    // 1. Verify Event Ownership
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    if (event.organizer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized. You do not own this event.' });
    }

    // 2. Calculate Total Earned (Sum of all valid ticket prices)
    const validTickets = await Ticket.find({ 
      event: eventId, 
      status: { $ne: 'cancelled' } 
    });

    // The organizer keeps the exact ticketPrice (platform fee was charged on top)
    const totalEarned = validTickets.reduce((sum, ticket) => sum + (ticket.ticketPrice || 0), 0);

    // 3. Calculate Already Requested / Paid Out
    const existingPayouts = await Payout.find({ 
      event: eventId, 
      status: { $in: ['pending', 'otp_required', 'approved'] } 
    });

    const alreadyRequested = existingPayouts.reduce((sum, payout) => sum + payout.amount, 0);

    // 4. Determine Available Balance
    const availableBalance = totalEarned - alreadyRequested;

    if (availableBalance <= 0 || amount > availableBalance) {
      return res.status(400).json({ 
        success: false, 
        message: `Insufficient balance. Your available balance is ₦${availableBalance}.` 
      });
    }

    // 5. Create the Pending Payout Request
    const payout = await Payout.create({
      organizer: req.user._id,
      event: eventId,
      amount,
      bankDetails,
      status: 'pending'
    });

    return res.status(201).json({ 
      success: true, 
      message: 'Payout request submitted successfully and is pending admin approval.', 
      payout 
    });

  } catch (error) {
    console.error('Payout request error:', error);
    return res.status(500).json({ success: false, message: 'Server error while requesting payout.' });
  }
};

// ==========================================
// GET ORGANIZER'S PAYOUTS
// ==========================================
export const getOrganizerPayouts = async (req, res) => {
  try {
    const payouts = await Payout.find({ organizer: req.user._id })
      .populate('event', 'title image date')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: payouts.length, payouts });
  } catch (error) {
    console.error('Get payouts error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load payouts.' });
  }
};


// ==========================================
// GET ALL PAYOUTS (Admin Only)
// ==========================================
export const getAllPayouts = async (req, res) => {
  try {
    const payouts = await Payout.find()
      .populate('event', 'title')
      .populate('organizer', 'name email')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, payouts });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error loading payouts.' });
  }
};

// ==========================================
// APPROVE PAYOUT — MANUAL TRANSFER (Admin Only)
//
// Your Paystack account is a Starter Business, which cannot initiate
// transfers to third-party bank accounts (Paystack blocks this outright
// with "You cannot initiate third party payouts as a starter business").
// So this does NOT call Paystack's Transfer API. Instead:
//   1. The admin sends the money to the organizer themselves, via their
//      own bank app/USSD, using payout.bankDetails shown in the admin UI.
//   2. The admin then calls this endpoint with the bank's transaction
//      reference as proof, and the payout is marked approved.
//
// If you later upgrade to a Registered Business on Paystack, this is
// where you'd swap back in the Transfer Recipient + Transfer API calls.
// The Payout model still has recipientCode/transferCode/
// paystackTransferId fields reserved for that.
// ==========================================
export const approvePayout = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentReference } = req.body;

    if (!paymentReference || !paymentReference.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Enter the bank transaction reference for the manual transfer before approving.'
      });
    }

    const payout = await Payout.findById(id);

    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found.' });
    }

    if (payout.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'This payout has already been processed.' });
    }

    payout.status = 'approved';
    payout.paidManually = true;
    payout.paymentReference = paymentReference.trim();
    await payout.save();

    return res.status(200).json({
      success: true,
      message: 'Payout marked as approved and paid manually.',
      payout
    });

  } catch (error) {
    console.error('Approve payout error:', error);
    return res.status(500).json({ success: false, message: 'Server error during approval.' });
  }
};
