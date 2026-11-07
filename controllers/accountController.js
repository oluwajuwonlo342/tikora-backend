// controllers/account.controller.js
import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { sendBrevoEmail, escapeHtml } from "../utils/brevoMail.js";

// Same password rule as register in authController.js
const PASSWORD_REGEX =
  /^(?=.*[0-9])(?=.*[!@#$%^&*.,_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Your JWT payload is { id, role }. Depending on how your auth middleware
// sets req.user, the id is either req.user.id or req.user._id.
const getUserId = (req) => req.user?.id || req.user?._id;

// ---------------------------------------------------------------
// PUT /api/auth/profile   body: { name, phone, email?, currentPassword? }
//
// Changing the email is the one sensitive change here, so it needs the
// current password. Without it, anyone who found a logged-in phone could
// quietly move the account to their own email address.
// ---------------------------------------------------------------
export const updateProfile = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    const phone = req.body.phone?.trim() || "";
    const newEmail = req.body.email?.trim().toLowerCase();
    const { currentPassword } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required." });
    }

    const user = await User.findById(getUserId(req));

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    const oldEmail = user.email;
    const emailChanged = !!newEmail && newEmail !== oldEmail;

    if (emailChanged) {
      if (!EMAIL_REGEX.test(newEmail)) {
        return res
          .status(400)
          .json({ success: false, message: "Please enter a valid email address." });
      }

      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message: "Enter your current password to change your email.",
        });
      }

      const passwordMatches = await bcrypt.compare(currentPassword, user.password);
      if (!passwordMatches) {
        return res
          .status(400)
          .json({ success: false, message: "Current password is incorrect." });
      }

      const emailTaken = await User.findOne({ email: newEmail, _id: { $ne: user._id } });
      if (emailTaken) {
        return res.status(409).json({
          success: false,
          message: "That email is already used by another account.",
        });
      }

      user.email = newEmail;
    }

    user.name = name;
    user.phone = phone;
    await user.save();

    // Tell the OLD address that the email was changed (security notice, in the background)
    if (emailChanged) {
      sendBrevoEmail({
        to: oldEmail,
        toName: user.name,
        subject: "Your Tickora email address was changed",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;">
            <h2 style="color:#111;">Email address changed</h2>
            <p style="color:#555;line-height:1.6;">
              Hi ${escapeHtml(user.name)}, the email on your Tickora account was changed to
              <strong>${escapeHtml(newEmail)}</strong>.
            </p>
            <p style="color:#555;line-height:1.6;">
              If this was you, no action is needed. If it wasn't, reset your password straight away
              and contact support.
            </p>
          </div>
        `,
      }).catch((err) => console.error("Email-change notice failed:", err.message));
    }

    return res.json({
      success: true,
      message: emailChanged ? "Profile and email updated." : "Profile updated.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    // Two requests changing to the same email at once
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "That email is already used by another account.",
      });
    }

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