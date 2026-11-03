// controllers/account.controller.js
import bcrypt from "bcryptjs";
import User from "../models/User.js";

// Same password rule as register in authController.js
const PASSWORD_REGEX =
  /^(?=.*[0-9])(?=.*[!@#$%^&*.,_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;

// Your JWT payload is { id, role }. Depending on how your auth middleware
// sets req.user, the id is either req.user.id or req.user._id.
const getUserId = (req) => req.user?.id || req.user?._id;

// ---------------------------------------------------------------
// PUT /api/auth/profile   body: { name, phone }
// ---------------------------------------------------------------
export const updateProfile = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const phone = req.body.phone?.trim() || "";

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required." });
    }

    const user = await User.findByIdAndUpdate(
      getUserId(req),
      { name, phone },
      { new: true, runValidators: true }
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    return res.json({
      success: true,
      message: "Profile updated.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("updateProfile error:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

// ---------------------------------------------------------------
// PUT /api/auth/change-password   body: { currentPassword, newPassword }
// ---------------------------------------------------------------
export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current and new password are required.",
      });
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 8 characters long, containing at least one number and one special character.",
      });
    }

    const user = await User.findById(getUserId(req));

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect." });
    }

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    return res.json({
      success: true,
      message: "Password changed successfully.",
    });
  } catch (error) {
    console.error("changePassword error:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
