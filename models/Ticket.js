import mongoose from 'mongoose';

const ticketSchema = new mongoose.Schema({
  ticketCode: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  qrCode: {
    type: String,
    required: true
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  event: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true,
    index: true
  },
  organizer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  ticketType: {
    type: String,
    required: true,
    trim: true
  },
  price: {
    type: Number,
    default: 0,
    min: 0
  },
  ticketPrice: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  platformFee: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  totalAmount: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  paymentReference: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  attendee: {
    firstName: { 
      type: String, 
      required: true, 
      trim: true 
    },
    lastName: { 
      type: String, 
      default: '', 
      trim: true 
    },
    email: { 
      type: String, 
      required: true, 
      lowercase: true, 
      trim: true,
      index: true 
    },
    phone: { 
      type: String, 
      default: '', 
      trim: true 
    }
  },
  status: {
    type: String,
    enum: ['valid', 'used', 'cancelled'],
    default: 'valid',
    index: true
  },
  usedAt: {
    type: Date,
    default: null
  }
}, { 
  timestamps: true 
});

// ==========================================
// INDEXES FOR HIGH-SPEED QUERIES
// ==========================================
// Fast lookup when organizers query attendees by event
ticketSchema.index({ event: 1, status: 1 });

// Fast lookup for user ticket history across events
ticketSchema.index({ buyer: 1, createdAt: -1 });

export default mongoose.model('Ticket', ticketSchema);
