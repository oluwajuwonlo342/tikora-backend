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
// for an event. The payout form, the Wallet page, the Dashboard, the
// admin table and the payout request check all use this, so every
// screen shows the same number.
//
//   totalEarned = the price each buyer ACTUALLY PAID for their ticket
//                 (ticketPrice saved on the ticket when it was bought),
//                 for every ticket that was not cancelled.
//                 (The 7% platform fee is charged to buyers on top,
//                 so it is NOT part of the organizer's earnings.)
//   paid        = payouts already approved
//   pending     = payouts requested and waiting for approval
//   available   = totalEarned - paid - pending
//
// Why not "current ticket price x number sold"? Because an organizer can
// edit a ticket price after some tickets were sold. Using the price saved
// at purchase means a later price edit can never change what was already
// earned. The price x sold figure is still returned (tierEstimate) so any
// difference can be spotted.
//
// Rejected payouts are NOT counted, so that money goes back to the organizer.
//
// Pass the event document as the second argument if you already loaded it
// (it needs the `tickets` field) to save a database query.
// ==========================================
const PAID_STATUSES = ['approved'];
const PENDING_STATUSES = ['pending', 'otp_required'];

export const calculateEventBalance = async (eventId, eventDoc = null) => {
  // What buyers actually paid (price frozen at the time of purchase)
  const allTickets = await Ticket.find({ event: eventId }).select('ticketPrice status');
  const liveTickets = allTickets.filter((t) => t.status !== 'cancelled');
  const cancelledTickets = allTickets.filter((t) => t.status === 'cancelled');

  const totalEarned = liveTickets.reduce(
    (sum, t) => sum + (Number(t.ticketPrice) || 0),
    0
  );

  // Cross-check only: current ticket-type price x sold. This MOVES if the
  // organizer edits a price, so it is never used for the real balance.
  const event = eventDoc || (await Event.findById(eventId).select('tickets'));
  const tiers = Array.isArray(event?.tickets) ? event.tickets : [];
  const byTier = tiers.map((tier) => {
    const price = Number(tier.price) || 0;
    const sold = Number(tier.sold) || 0;
    return { name: tier.name, currentPrice: price, sold, subtotal: price * sold };
  });
  const tierEstimate = byTier.reduce((sum, t) => sum + t.subtotal, 0);

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
    ticketCount: liveTickets.length,
    // Diagnostics
    byTier,
    tierEstimate,
    differenceFromTierEstimate: totalEarned - tierEstimate,
    cancelledCount: cancelledTickets.length,
    cancelledValue: cancelledTickets.reduce((sum, t) => sum + (Number(t.ticketPrice) || 0), 0),
    unpricedTickets: liveTickets.filter((t) => !(Number(t.ticketPrice) > 0)).length
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

    const balance = await calculateEventBalance(eventId, event);

    return res.status(200).json({ success: true, balance });
  } catch (error) {
    console.error('Get payout balance error:', error);
    return res.status(500).json({ success: false, message: 'Could not load balance.' });
  }
};

// ==========================================
// GET BALANCES FOR ALL OF AN ORGANIZER'S EVENTS
// GET /api/payouts/my-balances
// Returns { balances: { [eventId]: { totalEarned, paid, pending, available, ... } } }
// ==========================================
export const getMyEventBalances = async (req, res) => {
  try {
    const events = await Event.find({ organizer: req.user._id }).select('_id tickets');

    const balances = {};
    await Promise.all(
      events.map(async (event) => {
        balances[event._id.toString()] = await calculateEventBalance(event._id, event);
      })
    );

    return res.status(200).json({ success: true, balances });
  } catch (error) {
    console.error('Get my balances error:', error);
    return res.status(500).json({ success: false, message: 'Could not load balances.' });
  }
};

// ==========================================
// GET BALANCES FOR EVERY EVENT (Admin Only)
// GET /api/payouts/admin/event-balances
// Used by the admin Event Moderation table.
// ==========================================
export const getAllEventBalances = async (req, res) => {
  try {
    const events = await Event.find().select('_id tickets');

    const balances = {};
    await Promise.all(
      events.map(async (event) => {
        balances[event._id.toString()] = await calculateEventBalance(event._id, event);
      })
    );

    return res.status(200).json({ success: true, balances });
  } catch (error) {
    console.error('Get all event balances error:', error);
    return res.status(500).json({ success: false, message: 'Could not load event balances.' });
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
    const { totalEarned, paid, pending, available } = await calculateEventBalance(eventId, event);

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