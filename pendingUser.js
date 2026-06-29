const mongoose = require("mongoose");

const pendingUserSchema = new mongoose.Schema({
  role: { type: String, required: true },
  outlet: [{ type: String }],
  firstName: { type: String, required: true },
  middleName: { type: String },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  contactNumber: { type: String, required: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// ✅ Auto-delete pending registration after 5 minutes
pendingUserSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

const PendingUser = mongoose.model("PendingUser", pendingUserSchema);
module.exports = PendingUser;
