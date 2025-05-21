const mongoose = require("mongoose");

const CompetitorSchema = new mongoose.Schema(
  {
    date: {
      type: String, // Or Date if you want to store as date type
      required: true,
    },
    userEmail: { type: String, required: true },
    merchandiser: {
      type: String,
      required: true,
    },
    outlet: {
      type: String,
      required: true,
    },
    store: {
      type: String,
      default: "",
    },
    company: {
      type: String,
      default: "",
    },
    brand: {
      type: String,
      default: "",
    },
    promoType: {
      type: String,
      default: null,
    },
    promoDetails: {
      type: String,
      default: "",
    },
    displayLocation: {
      type: String,
      default: "",
    },
    pricing: {
      type: String,
      default: "",
    },
    duration: {
      type: String,
      default: "",
    },
    impact: {
      type: String,
      default: "",
    },
    feedback: {
      type: String,
      default: "",
    },
  },
  {
    timestamps: true, // Optional: adds createdAt and updatedAt fields
  }
);

module.exports = mongoose.model("Competitor", CompetitorSchema);
