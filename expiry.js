const mongoose = require("mongoose");

const expiryEntrySchema = new mongoose.Schema({
  month: {
    type: String,
    required: true,
  },
  sku: {
    type: String,
    required: true,
  },
  expiration: {
    type: String, // You can change to Date if you want strict date format
    required: true,
  },
});

const expirySchema = new mongoose.Schema({
  date: {
    type: String,
    required: true,
  },
  merchandiser: {
    type: String,
    required: true,
  },
  outlet: {
    type: String,
    required: true,
  },
  expiryEntries: {
    type: [expiryEntrySchema],
    required: true,
  },
  userEmail: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Expiry = mongoose.model("Expiry", expirySchema);
module.exports = Expiry;
