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
// GET BANK LIST (Via Paystack)
//
// Cached in memory for 24h since the bank list rarely changes and
// this avoids hitting Paystack on every payout form load.
// ==========================================
let bankListCache = { data: null, fetchedAt: 0 };
const BANK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const getBanks = async (req, res) => {
  try {
    const isFresh = bankListCache.data && (Date.now() - bankListCache.fetchedAt < BANK_CACHE_TTL_MS);

    if (isFresh) {
      return res.status(200).json({ success: true, banks: bankListCache.data, cached: true });
    }

    const response = await axios.get(`${PAYSTACK_BASE}/bank`, {
      headers: paystackHeaders,
      params: {
        country: 'nigeria',
        currency: 'NGN',
        perPage: 200
      }
    });

    // Only keep NUBAN-type banks — these are the ones /bank/resolve and
    // transfers actually work with.
    const banks = (response.data.data || [])
      .filter((b) => b.type === 'nuban' && b.active !== false)
      .map((b) => ({ code: b.code, name: b.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    bankListCache = { data: banks, fetchedAt: Date.now() };

    return res.status(200).json({ success: true, banks, cached: false });
  } catch (error) {
    console.error('Get banks error:', error.response?.data || error.message);

    // Serve stale cache rather than failing outright, if we have one
    if (bankListCache.data) {
      return res.status(200).json({ success: true, banks: bankListCache.data, cached: true, stale: true });
    }

    return res.status(502).json({ success: false, message: 'Could not load bank list from Paystack.' });
  }
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

    const paystackMessage = error.response?.data?.message;
    return res.status(400).json({
      success: false,
      message: paystackMessage || 'Could not verify account details. Please check the account number and bank.'
    });
  }
};

// ==========================================
// SHARED BALANCE CALCULATION
//
// ONE place that works out how much an organizer can still withdraw
// for an event. Both the payout form (via GET /payouts/balance/:eventId)
// and the payout request check use this, so the number the organizer
// sees is always the number the server enforces.
//
//   totalEarned = ticket prices of all non-cancelled tickets
//                 (the platform fee is charged on top, so the organizer
//                 keeps the exact ticketPrice)
//   paid        = payouts already approved
//   pending     = payouts requested and waiting for approval
//   available   = totalEarned - paid - pending
//
// Rejected payouts are NOT counted, so that money goes back to the organizer.
// ==========================================
const PAID_STATUSES = ['approved'];
const PENDING_STATUSES = ['pending', 'otp_required'];

export const calculateEventBalance = async (eventId) => {
  const validTickets = await Ticket.find({
    event: eventId,
    status: { $ne: 'cancelled' }
  }).select('ticketPrice');

  const totalEarned = validTickets.reduce(
    (sum, ticket) => sum + (Number(ticket.ticketPrice) || 0),
    0
  );

  const payouts = await Payout.find({
    event: eventId,
    status: { $in: [...PAID_STATUSES, ...PENDING_STATUSES] }
  }).select('amount status');

  const paid = payouts
    .filter((p) => PAID_STATUSES.includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  const pending = payouts
    .filter((p) => PENDING_STATUSES.includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  const available = Math.max(totalEarned - paid - pending, 0);

  return {
    totalEarned,
    paid,
    pending,
    available,
    ticketCount: validTickets.length
  };
};

// ==========================================
// GET BALANCE FOR ONE EVENT (Organizer or Admin)
// GET /api/payouts/balance/:eventId
// ==========================================
export const getPayoutBalance = async (req, res) => {
  try {
    const { eventId } = req.params;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    const isOwner = event.organizer.toString() === req.user._id.toString();
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Unauthorized. You do not own this event.' });
    }

    const balance = await calculateEventBalance(eventId);

    return res.status(200).json({ success: true, balance });
  } catch (error) {
    console.error('Get payout balance error:', error);
    return res.status(500).json({ success: false, message: 'Could not load balance.' });
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

    // 2. Work out the balance (same calculation the form displays)
    const { totalEarned, paid, pending, available } = await calculateEventBalance(eventId);

    if (available <= 0 || amount > available) {
      return res.status(400).json({
        success: false,
        message:
          `Insufficient balance. Available: ₦${available.toLocaleString()} ` +
          `(earned ₦${totalEarned.toLocaleString()}, paid ₦${paid.toLocaleString()}, ` +
          `pending ₦${pending.toLocaleString()}).`
      });
    }

    // 3. Create the Pending Payout Request
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
// transfers to third-party bank accounts. So this does NOT call
// Paystack's Transfer API. Instead:
//   1. The admin sends the money to the organizer themselves, via their
//      own bank app/USSD, using payout.bankDetails shown in the admin UI.
//   2. The admin then calls this endpoint with the bank's transaction
//      reference as proof, and the payout is marked approved.
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