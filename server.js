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
import payoutRoutes from "./routes/payoutRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const app = express();
app.set("trust proxy", 1);

// CLIENT_URL can be one URL or several separated by commas
const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 1 ? allowedOrigins : allowedOrigins[0],
    credentials: true,
  })
);
app.use(helmet());
app.use(morgan("dev"));
app.use(cookieParser());

// FIX: keep the exact raw bytes of every JSON request as req.rawBody.
// The Paystack webhook signature must be checked against these raw bytes.
// Without this, genuine webhooks can be rejected as "invalid signature".
app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  // FIX: never rate-limit Paystack's webhook (all calls come from Paystack's IPs)
  skip: (req) => req.originalUrl.split("?")[0].endsWith("/webhook"),
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
app.use("/api/payouts", payoutRoutes);
app.use("/api/admin", adminRoutes);

// 404 for unknown routes (returns JSON instead of Express's HTML page)
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Last-resort error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ success: false, message: "Internal server error" });
});

const PORT = process.env.PORT || 5000;

// Start listening only after the database is connected and indexes are fixed
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
