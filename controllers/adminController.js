import User from '../models/User.js';
import Event from '../models/Event.js';

export const getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeEvents = await Event.countDocuments();
    
    // Dynamically calculate platform revenue (7% fee) from all ticket sales
    const events = await Event.find();
    let platformRevenue = 0;

    events.forEach(evt => {
      let eventGross = 0;
      
      // Calculate from ticket tiers
      if (evt.tickets && evt.tickets.length > 0) {
        evt.tickets.forEach(tier => {
          eventGross += (tier.sold || 0) * (tier.price || 0);
        });
      } else if (evt.eventRevenue) {
        // Fallback for any legacy data
        eventGross = evt.eventRevenue;
      }
      
      // Add 7% of this event's gross to the platform total
      platformRevenue += (eventGross * 0.07);
    });

    res.status(200).json({
      success: true,
      stats: {
        totalRevenue: platformRevenue,
        totalUsers,
        activeEvents
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Failed to fetch platform stats' });
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.status(200).json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
};

export const getAllEvents = async (req, res) => {
  try {
    const events = await Event.find()
      .populate('organizer', 'name email')
      .sort({ createdAt: -1 });

    // ✅ Attach calculated financial metrics and total tickets sold to each event for the admin view
    const eventsWithFinancials = events.map(event => {
      let grossEarned = 0;
      let ticketsSoldCount = 0;

      if (event.tickets && event.tickets.length > 0) {
        event.tickets.forEach(tier => {
          const sold = tier.sold || 0;
          const price = tier.price || 0;
          grossEarned += sold * price;
          ticketsSoldCount += sold;
        });
      }

      const platformFee = grossEarned * 0.07; // 7% platform fee

      return {
        ...event.toObject(),
        grossEarned,
        platformFee,
        ticketsSoldCount
      };
    });

    res.status(200).json({ success: true, events: eventsWithFinancials });
  } catch (error) {
    console.error("Get all events error:", error);
    res.status(500).json({ success: false, message: 'Failed to fetch events' });
  }
};
