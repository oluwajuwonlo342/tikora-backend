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
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
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