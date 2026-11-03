import express from "express";

import {
  register,
  login,
} from "../controllers/authController.js";
import { forgotPassword, resetPassword } from "../controllers/passwordReset.controller.js";
import { updateProfile, changePassword } from "../controllers/accountController.js";

router.put("/profile", protect, updateProfile);
router.put("/change-password", protect, changePassword);
const router = express.Router();

router.post("/register", register);

router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password/:token", resetPassword);

export default router;
