const mongoose = require("mongoose");

const AdminUserSchema = new mongoose.Schema(
  {
    roleAccount: String,
    remarks: String,
    firstName: String,
    middleName: String,
    lastName: String,
    emailAddress: { type: String, unique: true },
    contactNum: String,
    password: String,
    isVerified: Boolean,
    outlet: [String],
    type: Number,
  },
  {
    collection: "adminUsers",
  }
);

const AdminUser = mongoose.model("adminUsers", AdminUserSchema);
module.exports = AdminUser;
