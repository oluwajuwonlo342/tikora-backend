import mongoose from "mongoose";
import Ticket from "../models/Ticket.js";

// Removes the old UNIQUE index on tickets.paymentReference.
// Every ticket in one purchase shares the same paymentReference, so that
// index made the 2nd ticket fail with E11000 and broke verification.
// Mongoose never drops indexes on its own when a schema changes, so we do it here.
const fixTicketIndexes = async () => {
  try {
    let indexes = [];
    try {
      indexes = await Ticket.collection.indexes();
    } catch (err) {
      // Collection doesn't exist yet (fresh database): nothing to clean up
      if (err.codeName !== "NamespaceNotFound" && err.code !== 26) throw err;
    }

    const badIndex = indexes.find(
      (idx) => idx.name === "paymentReference_1" && idx.unique
    );

    if (badIndex) {
      await Ticket.collection.dropIndex("paymentReference_1");
      console.log("Dropped stale UNIQUE index tickets.paymentReference_1");
    }

    // Creates the indexes defined in the schema (non-unique paymentReference, etc.)
    await Ticket.createIndexes();
    console.log("Ticket indexes are up to date");
  } catch (error) {
    // Never crash the server because of index maintenance
    console.error("Ticket index maintenance failed:", error.message);
  }
};

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);

    console.log(`MongoDB connected: ${conn.connection.host} (db: ${conn.connection.name})`);

    await fixTicketIndexes();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
