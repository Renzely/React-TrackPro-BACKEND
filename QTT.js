const mongoose = require("mongoose");

const QTTProcessSchema = new mongoose.Schema({
  userType: { type: String, enum: ["PSR", "VET"], required: true },
  date: { type: String, required: true },
  userEmail: { type: String, required: true },
  merchandiser: { type: String, required: true },
  outlet: { type: String, required: true },
  beforeImage: { type: String }, // URI or base64
  afterImage: { type: String },

  // For PSR
  firstBrandSeen: { type: String }, // Yes/No
  complianceDOG: { type: String }, // Yes/No
  complianceCAT: { type: String }, // Yes/No

  // For VET
  shelfSpace: { type: String }, // Yes/No
  designatedRack: { type: String }, // Yes/No
});

module.exports = mongoose.model("QTTProcess", QTTProcessSchema);
