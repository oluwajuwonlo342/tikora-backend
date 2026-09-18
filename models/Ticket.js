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
  paymentReference: { 
    type: String, 
    required: true 
  },
  
  // NEW: Added Attendee Information object
  attendee: {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true }
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

export default mongoose.model('Ticket', ticketSchema);