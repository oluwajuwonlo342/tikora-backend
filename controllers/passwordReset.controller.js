// controllers/passwordReset.controller.js
import crypto from "crypto";
import nodemailer from "nodemailer";
import User from "../models/User.js";

const RESET_TOKEN_MINUTES = 30;

// If you already have a nodemailer transporter / sendEmail helper for Brevo,
// import and use that instead of this one.
const transporter = nodemailer.createTransport({
  host: process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com",
  port: Number(process.env.BREVO_SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.BREVO_SMTP_USER,
    pass: process.env.BREVO_SMTP_PASS,
  },
});

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

// ---------------------------------------------------------------
// POST /api/auth/forgot-password   body: { email }
// ---------------------------------------------------------------
export const forgotPassword = async (req, res) => {
  // Same response every time, so nobody can discover which emails are registered
  const genericResponse = {
    success: true,
    message: "If an account exists for that email, a reset link has been sent.",
  };

  try {
    const email = req.body.email?.trim().toLowerCase();

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(200).json(genericResponse);

    // Raw token goes in the email; only its hash is stored in the database
    const rawToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = hashToken(rawToken);
    user.resetPasswordExpires = Date.now() + RESET_TOKEN_MINUTES * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${rawToken}`;

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM, // e.g. '"Tickora" <no-reply@yourdomain.com>'
        to: user.email,
        subject: "Reset your Tickora password",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;">
            <h2 style="color:#111;">Reset your password</h2>
            <p style="color:#555;line-height:1.6;">
              Hi ${user.name || "there"}, we received a request to reset your password.
              Click the button below to choose a new one. This link expires in
              ${RESET_TOKEN_MINUTES} minutes.
            </p>
            <p style="margin:28px 0;">
              <a href="${resetUrl}"
                 style="background:#ff5a36;color:#fff;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:bold;">
                Reset password
              </a>
            </p>
            <p style="color:#888;font-size:13px;line-height:1.6;">
              If the button doesn't work, copy this link into your browser:<br/>
              ${resetUrl}
            </p>
            <p style="color:#888;font-size:13px;">
              If you didn't ask for this, you can ignore this email. Your password won't change.
            </p>
          </div>
        `,
      });
    } catch (mailError) {
      // Clear the token so a failed email doesn't leave a usable token behind
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save({ validateBeforeSave: false });
      console.error("Password reset email failed:", mailError);
    }

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error("forgotPassword error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
};

// ---------------------------------------------------------------
// POST /api/auth/reset-password/:token   body: { password }
// ---------------------------------------------------------------
export const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters.",
      });
    }

    const user = await User.findOne({
      resetPasswordToken: hashToken(token),
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message:
          "This reset link is invalid or has expired. Please request a new one.",
      });
    }

    // IMPORTANT: this assumes your User model hashes passwords in a
    // pre("save") hook (same as your register flow). If you hash manually
    // in the register controller instead, hash here the same way, e.g.
    //   user.password = await bcrypt.hash(password, 10);
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful. You can now log in.",
    });
  } catch (error) {
    console.error("resetPassword error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error. Please try again." });
  }
};
