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
      // 'otp_required': Paystack created the transfer but it needs OTP
      // confirmation (either in the Paystack dashboard, or via a finalize
      // step) before money actually moves.
      type: String,
      enum: ['pending', 'otp_required', 'approved', 'rejected'],
      default: 'pending',
    },
    // Paystack transfer recipient code (e.g. "RCP_xxx"), created once per
    // payout and reused if the first transfer attempt has to be retried.
    recipientCode: {
      type: String,
      default: '',
    },
    // Paystack transfer code (e.g. "TRF_xxx"), returned when the transfer
    // is initiated. Needed to finalize an OTP-pending transfer later.
    transferCode: {
      type: String,
      default: '',
    },
    // Paystack's internal numeric transfer id, also returned on initiate.
    paystackTransferId: {
      type: Number,
    },
    // Kept for compatibility with any existing code/UI that reads this
    // field; mirrors transferCode once a transfer has been initiated.
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
