import "./config/env.js";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/authRoutes.js";
import eventRoutes from "./routes/eventRoutes.js";
import connectDB from "./config/db.js";
import ticketRoutes from "./routes/ticketRoutes.js";
// ✅ IMPORT PAYOUT ROUTES
import payoutRoutes from "./routes/payoutRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const app = express();

connectDB();

// Find your cors setup and update the origin array:
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);
app.use(helmet());
app.use(morgan("dev"));
app.use(cookieParser());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

app.use("/api", limiter);

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Event Ticketing API is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "API is healthy",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/tickets", ticketRoutes);
// ✅ MOUNT PAYOUT ROUTES
app.use("/api/payouts", payoutRoutes);
app.use("/api/admin", adminRoutes);
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
