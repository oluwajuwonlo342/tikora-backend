import User from '../models/User.js';
import Event from '../models/Event.js';

export const getDashboardStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeEvents = await Event.countDocuments();
    
    // ✅ FIX: Dynamically calculate platform revenue (7% fee) from all ticket sales
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
    const events = await Event.find().populate('organizer', 'name email').sort({ createdAt: -1 });
    res.status(200).json({ success: true, events });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch events' });
  }
};