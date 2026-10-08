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
// APPROVE & TRANSFER PAYOUT (Admin Only)
// This now actually moves money via Paystack's Transfer API instead of
// only flipping a status in the database.
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

    const { accountNumber, bankCode, accountName } = payout.bankDetails || {};
    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        success: false,
        message: 'This payout is missing bank details and cannot be transferred automatically.'
      });
    }

    // ==========================================
    // STEP 1: Create (or reuse) a Transfer Recipient
    // ==========================================
    let recipientCode = payout.recipientCode;

    if (!recipientCode) {
      try {
        const recipientRes = await axios.post(
          `${PAYSTACK_BASE}/transferrecipient`,
          {
            type: 'nuban',
            name: accountName || 'Event Organizer',
            account_number: accountNumber,
            bank_code: bankCode,
            currency: 'NGN'
          },
          { headers: paystackHeaders }
        );

        recipientCode = recipientRes.data.data.recipient_code;
        payout.recipientCode = recipientCode;
        await payout.save();
      } catch (recipientError) {
        console.error('Create transfer recipient error:', recipientError.response?.data || recipientError.message);
        return res.status(502).json({
          success: false,
          message: recipientError.response?.data?.message || 'Could not create transfer recipient on Paystack.'
        });
      }
    }

    // ==========================================
    // STEP 2: Initiate the Transfer
    // ==========================================
    let transferRes;
    try {
      transferRes = await axios.post(
        `${PAYSTACK_BASE}/transfer`,
        {
          source: 'balance',
          amount: Math.round(payout.amount * 100), // kobo
          recipient: recipientCode,
          reason: `Payout for event ${payout.event}`,
          reference: `payout-${payout._id}`
        },
        { headers: paystackHeaders }
      );
    } catch (transferError) {
      const data = transferError.response?.data;
      console.error('Initiate transfer error:', data || transferError.message);

      // Paystack returns 400 with a balance message when the account has insufficient funds
      return res.status(502).json({
        success: false,
        message: data?.message || 'Could not initiate transfer on Paystack.'
      });
    }

    const transferData = transferRes.data.data;
    payout.transferCode = transferData.transfer_code;
    payout.paystackTransferId = transferData.id;

    // ==========================================
    // STEP 3: Interpret the result
    // Paystack returns status "success" when it completes immediately,
    // or "otp"/"pending" when your account still requires OTP confirmation
    // for transfers (Paystack dashboard > Settings > Preferences).
    // ==========================================
    if (transferData.status === 'success') {
      payout.status = 'approved';
      await payout.save();

      return res.status(200).json({
        success: true,
        message: 'Payout approved and transferred successfully!',
        payout
      });
    }

    if (transferData.status === 'otp' || transferData.status === 'pending') {
      payout.status = 'otp_required';
      await payout.save();

      return res.status(202).json({
        success: false,
        message:
          'Transfer was created on Paystack but needs OTP confirmation before it will pay out. ' +
          'Either confirm it from your Paystack dashboard (Payouts > Transfers), or disable the ' +
          'Transfer OTP requirement under Paystack Settings > Preferences so future approvals complete automatically.',
        payout
      });
    }

    // Any other status: don't mark it approved, surface it for investigation
    console.error('Unexpected transfer status from Paystack:', transferData.status, transferData);
    return res.status(502).json({
      success: false,
      message: `Paystack returned an unexpected transfer status: ${transferData.status}. Check the Paystack dashboard.`,
      payout
    });

  } catch (error) {
    console.error('Approve payout error:', error);
    return res.status(500).json({ success: false, message: 'Server error during approval.' });
  }
};
