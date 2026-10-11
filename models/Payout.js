import mongoose from 'mongoose';

const payoutSchema = new mongoose.Schema(
  {
    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    bankDetails: {
      accountName: { type: String, required: true },
      accountNumber: { type: String, required: true },
      bankCode: { type: String, required: true },
      bankName: { type: String },
    },
    status: {
      // 'otp_required' is kept for compatibility in case you upgrade to a
      // Registered Business later and switch back to real Paystack
      // Transfers. The current manual-approval flow only ever uses
      // 'pending', 'approved' and 'rejected'.
      type: String,
      enum: ['pending', 'otp_required', 'approved', 'rejected'],
      default: 'pending',
    },

    // ==========================================
    // MANUAL PAYOUT FIELDS (used now, on Starter Business)
    // ==========================================
    // Set true once the admin has sent the money themselves via their own
    // bank app/USSD, outside Paystack — because a Starter Business cannot
    // initiate transfers to third-party bank accounts.
    paidManually: {
      type: Boolean,
      default: false,
    },
    // The bank's transaction reference/receipt ID, entered by the admin
    // as proof when they confirm a manual payout.
    paymentReference: {
      type: String,
      default: '',
    },

    // ==========================================
    // PAYSTACK TRANSFER FIELDS (unused while on Starter Business —
    // kept so you can switch back to automatic transfers without another
    // schema migration once you upgrade to a Registered Business)
    // ==========================================
    recipientCode: {
      type: String,
      default: '',
    },
    transferCode: {
      type: String,
      default: '',
    },
    paystackTransferId: {
      type: Number,
    },
    paystackTransferReference: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

const Payout = mongoose.model('Payout', payoutSchema);

// ✅ THIS IS THE CRITICAL EXPORT LINE THAT PREVENTS THE CRASH
export default Payout;
