import mongoose from 'mongoose';

const ticketSchema = new mongoose.Schema({
  ticketCode: {
    type: String,
    required: true,
    unique: true
  },
  qrCode: {
    type: String,
    required: true
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true
  },
  organizer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  ticketType: {
    type: String,
    required: true
  },
  // FIX: controller sets `price`, but it was missing from the schema (silently dropped)
  price: {
    type: Number,
    default: 0
  },
  ticketPrice: {
    type: Number,
    required: true
  },
  platformFee: {
    type: Number,
    required: true
  },
  totalAmount: {
    type: Number,
    required: true
  },
  // Shared by every ticket in one purchase, so it is indexed but NOT unique
  paymentReference: {
    type: String,
    required: true,
    index: true
  },

  attendee: {
    firstName: { type: String, required: true },
    // FIX: no longer required. Empty strings fail "required" in Mongoose,
    // which made insertMany throw for attendees without a last name or phone.
    lastName: { type: String, default: '' },
    email: { type: String, required: true },
    phone: { type: String, default: '' }
  },

  status: {
    type: String,
    enum: ['valid', 'used', 'cancelled'],
    default: 'valid'
  },
  usedAt: {
    type: Date
  }
}, { timestamps: true });

// Fast lookup of tickets sent to an attendee's email
ticketSchema.index({ 'attendee.email': 1 });

export default mongoose.model('Ticket', ticketSchema);
