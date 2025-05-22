const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
  email: String,
  otp: String,
  purpose: String, // <-- Add this line
  createdAt: { type: Date, default: Date.now, index: { expires: 300 } }, // Expires in 5 minutes
});

module.exports = mongoose.model("Otp", otpSchema);
