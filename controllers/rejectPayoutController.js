// controllers/rejectPayout.controller.js
// (You can also paste the function below into your existing payout controller.)
import Payout from "../models/Payout.js";

// ---------------------------------------------------------------
// POST /api/payouts/admin/reject/:id   body: { reason }
// ---------------------------------------------------------------
export const rejectPayout = async (req, res) => {
  try {
    const reason = req.body.reason?.trim();

    if (!reason) {
      return res
        .status(400)
        .json({ success: false, message: "A reason is required to reject a payout." });
    }

    const payout = await Payout.findById(req.params.id);

    if (!payout) {
      return res
        .status(404)
        .json({ success: false, message: "Payout request not found." });
    }

    // Only requests that are still waiting can be rejected
    if (payout.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `This payout was already ${payout.status}.`,
      });
    }

    payout.status = "rejected";
    payout.rejectionReason = reason;
    payout.rejectedAt = new Date();
    await payout.save();

    return res.json({
      success: true,
      message: "Payout request rejected.",
      payout,
    });
  } catch (error) {
    console.error("rejectPayout error:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
