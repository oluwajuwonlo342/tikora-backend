import mongoose from "mongoose";

const ticketTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    sold: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: true }
);

const eventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

category: {
    type: String,
    required: true,
    enum: [
      'music & concerts',
      'party & nightlife',
      'business & tech',
      'arts & culture',
      'sports & fitness',
      'education',
      'festivals',
      'comedy shows',
      'other'
    ],
  },
    date: {
      type: Date,
      required: true,
    },

    endDate: {
      type: Date,
      default: null,
    },

    location: {
      type: String,
      required: true,
      trim: true,
    },

    venue: {
      type: String,
      required: true,
      trim: true,
    },

    image: {
      type: String,
      required: true,
    },

    imagePublicId: {
      type: String,
      default: "",
    },

    organizer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // NEW: Staff array to allow multiple helpers to scan tickets
    staff: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      }
    ],

    tickets: {
      type: [ticketTypeSchema],
      required: true,
      validate: {
        validator: function (tickets) {
          return tickets.length > 0;
        },
        message: "At least one ticket type is required.",
      },
    },
eventRevenue: {
    type: Number,
    default: 0
  },
  eventTicketsSold: {
    type: Number,
    default: 0
  },
    status: {
      type: String,
      enum: [
        "draft",
        "published",
        "cancelled",
        "completed",
      ],
      default: "draft",
    },

    isFeatured: {
      type: Boolean,
      default: false,
    },

    views: {
      type: Number,
      default: 0,
      min: 0,
    },
  },

  {
    timestamps: true,
  }
);

const Event = mongoose.model("Event", eventSchema);

export default Event;