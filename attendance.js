const mongoose = require("mongoose");

const coordinateSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
  },
  { _id: false },
);

const timeLogSchema = new mongoose.Schema(
  {
    outlet: { type: String, required: true },
    shiftType: { type: String, enum: ["day", "graveyard"], default: "day" },
    timeIn: { type: Date, required: false }, // Store as Date, not String
    timeInPHString: { type: String, required: false }, // ✅ NEW

    timeInLocation: { type: String, required: false },
    timeInCoordinates: { type: coordinateSchema, required: false },
    timeInSelfieUrl: { type: String, required: false },

    timeOut: { type: Date, required: false }, // Store as Date
    timeOutPHString: { type: String, required: false }, // ✅ NEW

    timeOutLocation: { type: String, required: false },
    timeOutCoordinates: { type: coordinateSchema, required: false },
    timeOutSelfieUrl: { type: String, required: false },
  },
  { _id: false },
);

const attendanceSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD string
    timeLogs: { type: [timeLogSchema], default: [] },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Attendance", attendanceSchema);
