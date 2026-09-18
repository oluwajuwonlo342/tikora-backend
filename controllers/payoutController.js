import Payout from '../models/Payout.js';
import Ticket from '../models/Ticket.js';
import Event from '../models/Event.js';
import axios from 'axios';

// ==========================================
// VERIFY BANK ACCOUNT (Via Paystack)
// ==========================================
export const verifyBankAccount = async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;

    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: 'Account number and bank code are required.' });
    }

    const response = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
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
      status: { $in: ['pending', 'approved'] } 
    });

    const alreadyRequested = existingPayouts.reduce((sum, payout) => sum + payout.amount, 0);

    // 4. Determine Available Balance
    const availableBalance = totalEarned - alreadyRequested;

    if (availableBalance <= 0 || amountRequested > availableBalance) {
      return res.status(400).json({ 
        success: false, 
        message: `Insufficient balance. Your available balance is ₦${availableBalance}.` 
      });
    }

    // 5. Create the Pending Payout Request
    const payout = await Payout.create({
      organizer: req.user._id,
      event: eventId,
      amount: amountRequested,
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
// APPROVE & TRANSFER PAYOUT (Admin Only)
// ==========================================
export const approvePayout = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Find the pending payout in the database
    const payout = await Payout.findById(id);
    
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found.' });
    }

    if (payout.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'This payout has already been processed.' });
    }

    // ==========================================
    // PAYSTACK TRANSFER LOGIC (Optional/Live)
    // ==========================================
    /* 
    // To move real money automatically, you would call Paystack's Transfer API here:
    // 1. Create a Transfer Recipient using payout.bankDetails
    // 2. Initiate the Transfer using the recipient code
    // (If you are using Test Keys, Paystack won't let you transfer anyway)
    */

    // 2. Update the database status to 'approved'
    payout.status = 'approved';
    
    // 3. Save the changes permanently
    await payout.save();

    return res.status(200).json({ 
      success: true, 
      message: 'Payout approved successfully!',
      payout 
    });

  } catch (error) {
    console.error('Approve payout error:', error);
    return res.status(500).json({ success: false, message: 'Server error during approval.' });
  }
};