const mongoose = require("mongoose");

const coordinateSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
  },
  { _id: false }
);

const timeLogSchema = new mongoose.Schema(
  {
    outlet: { type: String, required: true }, // Outlet per time log entry

    timeIn: { type: String, required: false },
    timeInLocation: { type: String, required: false },
    timeInCoordinates: { type: coordinateSchema, required: false },
    timeInSelfieUrl: { type: String, required: false },

    timeOut: { type: String, required: false },
    timeOutLocation: { type: String, required: false },
    timeOutCoordinates: { type: coordinateSchema, required: false },
    timeOutSelfieUrl: { type: String, required: false },
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD string
    timeLogs: { type: [timeLogSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Attendance", attendanceSchema);
