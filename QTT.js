const mongoose = require("mongoose");

const QTTProcessSchema = new mongoose.Schema({
  userType: { type: String, enum: ["PSR", "VET"], required: true },
  date: { type: String, required: true },
  userEmail: { type: String, required: true },
  merchandiser: { type: String, required: true },
  outlet: { type: String, required: true },

  // Images for both types (S3 URLs)
  firstBrandImage: { type: String },
  complianceDOGImage: { type: String },
  complianceCATImage: { type: String },
  royalCaninSignageImage: { type: String },
  visibilityCashierImage: { type: String },
  endcapGondolaImage: { type: String },
  wetProductsHighlightImage: { type: String },
  tacticalBinImage: { type: String },
  shelfSpaceImage: { type: String },
  designatedRackImage: { type: String },

  // For PSR
  firstBrandSeen: { type: String }, // Yes/No
  complianceDOG: { type: String }, // Yes/No
  complianceCAT: { type: String }, // Yes/No
  royalCaninSignage: { type: String }, // Yes/No
  visibilityCashier: { type: String }, // Yes/No
  endcapGondola: { type: String }, // Yes/No
  wetProductsHighlight: { type: String }, // Yes/No
  tacticalBin: { type: String }, // Yes/No
  PSRComment: { type: String }, // Optional comment field

  // For VET
  shelfSpace: { type: String }, // Yes/No
  designatedRack: { type: String }, // Yes/No
});

module.exports = mongoose.model("QTTProcess", QTTProcessSchema);
