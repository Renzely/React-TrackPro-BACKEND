const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const AWS = require("aws-sdk");
const app = express();
app.use(cors());
app.use(express.json());
const Attendance = require("./attendance");
const auth = require("./auth");
const QTTProcess = require("./QTT");
const Competitors = require("./competitors");
const Expiry = require("./expiry");
const bcrypt = require("bcryptjs");
const User = require("./users");
const AdminUser = require("./adminUsers");
const authMiddleware = require("./auth");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const nodemailer = require("nodemailer");
const Otp = require("./otp");

// MongoDB Atlas connection
const uri = process.env.uri;

mongoose
  .connect(uri)
  .then(() => console.log("✅ Connected to MongoDB Atlas"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// ATTENDANCE

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

app.post("/save-attendance-images", (req, res) => {
  const { fileName } = req.body;

  const params = {
    Bucket: "rc-ugc-react-attendance",
    Key: fileName,
    Expires: 60,
    ContentType: "image/jpeg",
  };

  s3.getSignedUrl("putObject", params, (err, url) => {
    if (err) {
      return res
        .status(500)
        .json({ error: "Failed to generate pre-signed URL" });
    }

    res.json({ url });
  });
});

function parsePhilippineDateTimeAlternative(dateStr, timeStr) {
  const baseDate = new Date(dateStr);

  const timeStrTrimmed = timeStr.trim().replace(/\s+/g, " ");
  const [time, period] = timeStrTrimmed.split(" ");

  const [hours, minutes] = time.split(":");

  let hour24 = parseInt(hours);

  if (period?.toLowerCase() === "pm" && hour24 !== 12) {
    hour24 += 12;
  } else if (period?.toLowerCase() === "am" && hour24 === 12) {
    hour24 = 0;
  }

  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const day = baseDate.getDate();

  // Create the datetime string in Philippine timezone format
  const isoString = `${year}-${String(month + 1).padStart(2, "0")}-${String(
    day
  ).padStart(2, "0")}T${String(hour24).padStart(2, "0")}:${String(
    parseInt(minutes)
  ).padStart(2, "0")}:00.000+08:00`;

  return new Date(isoString);
}

// For your date field, also fix it to be in Philippine timezone
function createPhilippineDate(dateStr) {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  // Create date at midnight Philippine time
  const isoString = `${year}-${String(month + 1).padStart(2, "0")}-${String(
    day
  ).padStart(2, "0")}T00:00:00.000+08:00`;
  return new Date(isoString);
}

// Updated endpoint code
app.post("/attendance/time-in", async (req, res) => {
  try {
    console.log("Received /attendance/time-in request with body:", req.body);

    const { email, date, outlet, timeIn, selfieUrl, location, timeInLocation } =
      req.body;

    if (
      !email ||
      !date ||
      !outlet ||
      !timeIn ||
      !selfieUrl ||
      typeof location?.latitude !== "number" ||
      typeof location?.longitude !== "number"
    ) {
      console.log("Missing one or more required fields:", {
        email,
        date,
        outlet,
        timeIn,
        selfieUrl,
        location,
      });
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Create Philippine timezone date objects
    const dateObj = createPhilippineDate(date); // Use the new function
    const timeInObj = parsePhilippineDateTimeAlternative(date, timeIn); // Use alternative method

    // Log for debugging
    console.log("Original timeIn string:", timeIn);
    console.log("Parsed Philippine time:", timeInObj.toString());
    console.log("Philippine time ISO:", timeInObj.toISOString());

    let attendance = await Attendance.findOne({ email, date: dateObj });

    const timeLogData = {
      outlet,
      timeIn: timeInObj,
      timeInLocation:
        timeInLocation ||
        `Lat: ${location.latitude}, Long: ${location.longitude}`,
      timeInCoordinates: {
        latitude: location.latitude,
        longitude: location.longitude,
      },
      timeInSelfieUrl: selfieUrl,
    };

    if (attendance) {
      // Check if a timeLog already exists for this outlet
      const existingTimeLog = attendance.timeLogs.find(
        (log) => log.outlet === outlet
      );

      if (existingTimeLog) {
        // Update the existing timeLog with new timeIn info
        existingTimeLog.timeIn = timeLogData.timeIn;
        existingTimeLog.timeInLocation = timeLogData.timeInLocation;
        existingTimeLog.timeInCoordinates = timeLogData.timeInCoordinates;
        existingTimeLog.timeInSelfieUrl = timeLogData.timeInSelfieUrl;
      } else {
        // No existing timeLog for this outlet, push a new one
        attendance.timeLogs.push(timeLogData);
      }
    } else {
      // No attendance for this email and date, create new
      attendance = new Attendance({
        email,
        date: dateObj,
        timeLogs: [timeLogData],
      });
    }

    await attendance.save();
    return res.status(200).json({ message: "Time-in recorded successfully." });
  } catch (error) {
    console.error("Time-in error:", error);
    return res.status(500).json({ error: "Failed to save time-in." });
  }
});

app.post("/attendance/time-out", async (req, res) => {
  try {
    const {
      email,
      date,
      outlet,
      timeOut,
      timeOutSelfieUrl,
      location,
      timeOutLocation,
    } = req.body;

    if (
      !email ||
      !date ||
      !outlet ||
      !timeOut ||
      !timeOutSelfieUrl ||
      typeof location?.latitude !== "number" ||
      typeof location?.longitude !== "number"
    ) {
      console.log("Missing required fields for time-out:", req.body);
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Create Philippine timezone date objects
    const dateObj = createPhilippineDate(date); // Use the new function
    const timeOutObj = parsePhilippineDateTimeAlternative(date, timeOut); // Use alternative method

    // Log for debugging
    console.log("Original timeOut string:", timeOut);
    console.log("Parsed Philippine time:", timeOutObj.toString());

    const attendance = await Attendance.findOne({ email, date: dateObj });

    if (!attendance) {
      return res.status(404).json({ error: "Attendance record not found." });
    }

    // Find the latest timeLog for the outlet without timeOut set
    const lastTimeLog = [...attendance.timeLogs]
      .reverse()
      .find((log) => log.outlet === outlet && !log.timeOut);

    if (!lastTimeLog) {
      return res.status(404).json({
        error: "No corresponding time-in record found for this outlet.",
      });
    }

    lastTimeLog.timeOut = timeOutObj;
    lastTimeLog.timeOutLocation =
      timeOutLocation ||
      `Lat: ${location.latitude}, Long: ${location.longitude}`;
    lastTimeLog.timeOutCoordinates = {
      latitude: location.latitude,
      longitude: location.longitude,
    };
    lastTimeLog.timeOutSelfieUrl = timeOutSelfieUrl;

    await attendance.save();

    return res.status(200).json({ message: "Time-out recorded successfully." });
  } catch (error) {
    console.error("Time-out error:", error);
    return res.status(500).json({ error: "Failed to save time-out." });
  }
});

app.get("/user/outlets", auth, async (req, res) => {
  try {
    const userEmail = req.user?.email; // Make sure this comes from decoded token

    if (!userEmail)
      return res.status(400).json({ error: "Missing user email" });

    const user = await User.findOne({ email: userEmail });

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json(user.outlet || []);
  } catch (error) {
    console.error("Error in /user/outlets:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/attendance/status", async (req, res) => {
  const { email, outlet, date } = req.query;
  try {
    // Use the same createPhilippineDate function from your time-in/time-out endpoints
    const dateObj = createPhilippineDate(date);
    const attendance = await Attendance.findOne({ email, date: dateObj });

    if (!attendance) {
      return res.json({
        hasTimedIn: false,
        hasTimedOut: false,
        timeInTimestamp: null,
        timeOutTimestamp: null,
        addressTimeIn: null,
        addressTimeOut: null,
        timeInSelfieUri: null,
        timeOutSelfieUri: null,
      });
    }

    // Assuming attendance.timeLogs is an array of logs for outlets and timestamps
    const log = attendance.timeLogs.find((log) => log.outlet === outlet);
    if (!log) {
      return res.json({
        hasTimedIn: false,
        hasTimedOut: false,
        timeInTimestamp: null,
        timeOutTimestamp: null,
        addressTimeIn: null,
        addressTimeOut: null,
        timeInSelfieUri: null,
        timeOutSelfieUri: null,
      });
    }

    return res.json({
      hasTimedIn: !!log.timeIn,
      hasTimedOut: !!log.timeOut,
      timeInTimestamp: log.timeIn || null,
      timeOutTimestamp: log.timeOut || null,
      addressTimeIn: log.timeInLocation || null,
      addressTimeOut: log.timeOutLocation || null,
      timeInSelfieUri: log.timeInSelfieUrl || null,
      timeOutSelfieUri: log.timeOutSelfieUrl || null,
    });
  } catch (err) {
    console.error("Error fetching attendance status:", err);
    return res.status(500).json({ error: "Failed to fetch attendance status" });
  }
});

// MOBILE ATTENDANCE HISTORY

app.get("/attendance/history", async (req, res) => {
  const { email } = req.query;
  try {
    const attendanceList = await Attendance.find({ email }).sort({ date: -1 });

    const history = attendanceList.map((attendance) => {
      return {
        date: attendance.date,
        timeLogs: attendance.timeLogs.map((log) => ({
          outlet: log.outlet,
          timeIn: log.timeIn,
          timeOut: log.timeOut,
          addressTimeIn: log.timeInLocation,
          addressTimeOut: log.timeOutLocation,
          timeInSelfieUri: log.timeInSelfieUrl,
          timeOutSelfieUri: log.timeOutSelfieUrl,
        })),
      };
    });

    res.json(history);
  } catch (err) {
    console.error("Error fetching attendance history:", err);
    res.status(500).json({ error: "Failed to fetch attendance history" });
  }
});

// ADMIN ATTENDANCE HISTOTRY

app.post("/get-attendance", async (req, res) => {
  try {
    const { email, startDate, endDate } = req.body;

    let query = { email: email };

    // If date range is provided, add date filtering
    if (startDate && endDate) {
      const start = new Date(startDate + "T00:00:00.000Z");
      const end = new Date(endDate + "T23:59:59.999Z");

      query.$or = [
        {
          date: {
            $gte: start,
            $lte: end,
          },
        },
        {
          // Also handle string dates
          date: {
            $regex: new RegExp(
              startDate.replace(/-/g, "") + "|" + endDate.replace(/-/g, "")
            ),
          },
        },
      ];
    }

    // Fetch all attendance records for the user, sorted by date in ascending order
    const attendanceRecords = await Attendance.find(query).sort({
      date: 1,
    });

    if (!attendanceRecords.length) {
      return res.json({ success: true, data: [] });
    }

    // Log the raw data to inspect the time coordinates
    console.log(
      "Fetched Attendance Records:",
      JSON.stringify(attendanceRecords, null, 2)
    );

    // Flatten the data structure for frontend consumption
    const result = [];
    let count = 1;

    attendanceRecords.forEach((attendance) => {
      attendance.timeLogs.forEach((log) => {
        // Log each time log coordinates
        console.log("Time In Coordinates:", log.timeInCoordinates);
        console.log("Time Out Coordinates:", log.timeOutCoordinates);

        result.push({
          count: count++,
          email: attendance.email, // Add this line
          date: attendance.date,
          outlet: log.outlet || "",
          timeIn: log.timeIn,
          timeOut: log.timeOut,
          hasTimedIn: !!log.timeIn,
          hasTimedOut: !!log.timeOut,
          timeInLocation: log.timeInLocation || "No location provided",
          timeOutLocation: log.timeOutLocation || "No location provided",
          timeInCoordinates: log.timeInCoordinates || {
            latitude: 0,
            longitude: 0,
          },
          timeOutCoordinates: log.timeOutCoordinates || {
            latitude: 0,
            longitude: 0,
          },
          timeInSelfieUrl: log.timeInSelfieUrl || "",
          timeOutSelfieUrl: log.timeOutSelfieUrl || "",
        });
      });
    });

    console.log("Formatted Attendance Data:", JSON.stringify(result, null, 2));
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error in /get-attendance:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Attendance Export

// QTT Image

const QTTImage = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID_QTT_COMPE,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_QTT_COMPE,
  region: process.env.AWS_REGION_QTT_COMPE,
});

app.post("/get-qtt-url", (req, res) => {
  const { fileName } = req.body;
  if (!fileName) {
    return res.status(400).json({ error: "Missing fileName" });
  }

  const params = {
    Bucket: "qtt-scoring-rc",
    Key: `qtt/${fileName}`,
    Expires: 60,
    ContentType: "image/jpeg",
  };

  QTTImage.getSignedUrl("putObject", params, (err, url) => {
    if (err) {
      console.error("S3 Signed URL Error:", err);
      return res.status(500).json({ error: "Failed to generate URL" });
    }
    res.json({ url, key: params.Key });
  });
});

// QTT

app.post("/QTTsubmit", async (req, res) => {
  try {
    const {
      userType,
      userEmail,
      date,
      merchandiser,
      outlet,
      firstBrandSeen,
      complianceDOG,
      complianceCAT,
      shelfSpace,
      designatedRack,
      beforeImageKey,
      afterImageKey,
    } = req.body;

    const beforeImageUrl = `https://qtt-scoring-rc.s3.${process.env.AWS_REGION_QTT_COMPE}.amazonaws.com/${beforeImageKey}`;
    const afterImageUrl = `https://qtt-scoring-rc.s3.${process.env.AWS_REGION_QTT_COMPE}.amazonaws.com/${afterImageKey}`;

    const qttData = new QTTProcess({
      userType,
      userEmail,
      date,
      merchandiser,
      outlet,
      beforeImage: beforeImageUrl,
      afterImage: afterImageUrl,
      ...(userType === "PSR" && {
        firstBrandSeen,
        complianceDOG,
        complianceCAT,
      }),
      ...(userType === "VET" && {
        shelfSpace,
        designatedRack,
      }),
    });

    await qttData.save();
    res.status(200).json({ message: "Submitted successfully." });
  } catch (error) {
    console.error("Error submitting QTT:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/QTThistory", async (req, res) => {
  try {
    const userEmail = req.query.email;

    if (!userEmail) {
      return res.status(400).json({ message: "Missing user email" });
    }
    const history = await QTTProcess.find({ userEmail })
      .sort({ date: -1 })
      .exec();
    res.status(200).json(history);
  } catch (error) {
    console.error("Error fetching QTT history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// QTT HISTORY FOR ADMIN

app.post("/retrieve-QTTS-data", async (req, res) => {
  const { branches } = req.body; // frontend sends 'branches'

  if (!branches || !Array.isArray(branches)) {
    return res
      .status(400)
      .json({ status: 400, message: "Invalid branch data" });
  }

  try {
    const qttsData = await QTTProcess.find({
      outlet: { $in: branches }, // use branches to match outlet field
    });

    console.log("Filtered QTTS data:", qttsData);
    return res.status(200).json({ status: 200, data: qttsData });
  } catch (error) {
    console.error("Error retrieving QTTS data:", error);
    return res.status(500).json({ status: 500, message: "Server error" });
  }
});

//QTT PSR EXPORT

app.post("/export-PSR-data", async (req, res) => {
  const { start, end } = req.body;
  console.log("Received Request:", { start, end });

  try {
    // Convert timestamps to date strings (your schema uses string dates)
    const startDate = new Date(start).toISOString().split("T")[0];
    const endDate = new Date(end).toISOString().split("T")[0];

    console.log("Date range:", { startDate, endDate });

    const data = await mongoose.model("QTTProcess").aggregate([
      {
        $match: {
          date: { $gte: startDate, $lte: endDate }, // Fixed: use $lte instead of $lt
          userType: "PSR", // Fixed: use userType instead of selectedType
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userEmail",
          foreignField: "email",
          as: "user_details",
        },
      },
      {
        $addFields: {
          // Extract user details if available
          merchandiserName: {
            $ifNull: [
              { $arrayElemAt: ["$user_details.name", 0] },
              "$merchandiser", // Fallback to merchandiser field
            ],
          },
        },
      },
      {
        $project: {
          date: 1,
          merchandiserName: 1,
          outlet: 1,
          userType: 1,
          // Map the PSR-specific fields from your schema
          firstBrandSeen: { $ifNull: ["$firstBrandSeen", "No Answer"] },
          complianceDOG: { $ifNull: ["$complianceDOG", "No Answer"] },
          complianceCAT: { $ifNull: ["$complianceCAT", "No Answer"] },
          beforeImage: { $ifNull: ["$beforeImage", ""] },
          afterImage: { $ifNull: ["$afterImage", ""] },
        },
      },
      {
        $sort: {
          date: 1,
          merchandiserName: 1,
        },
      },
    ]);

    // Log the data to see what is returned from the aggregation query
    console.log("Query Result:", data);

    if (data.length === 0) {
      return res.status(200).send({ status: 200, data: [] }); // No data found
    }

    return res.send({ status: 200, data });
  } catch (error) {
    console.error("Aggregation Error:", error.message);
    return res.status(500).send({ error: error.message });
  }
});

// QTT VET EXPORT

app.post("/export-VET-data", async (req, res) => {
  const { start, end } = req.body;
  console.log("Received Request:", { start, end });

  try {
    // The dates are already in YYYY-MM-DD format from frontend
    console.log("Date range:", { start, end });

    const data = await mongoose.model("QTTProcess").aggregate([
      {
        $match: {
          date: { $gte: start, $lte: end }, // Fixed: use $lte instead of $lt, and dates are strings
          userType: "VET", // Fixed: use userType instead of selectedType
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userEmail",
          foreignField: "email",
          as: "user_details",
        },
      },
      {
        $addFields: {
          // Extract user details if available
          merchandiserName: {
            $ifNull: [
              { $arrayElemAt: ["$user_details.name", 0] },
              "$merchandiser", // Fallback to merchandiser field
            ],
          },
        },
      },
      {
        $project: {
          date: 1,
          merchandiserName: 1,
          outlet: 1,
          userType: 1,
          // Map the VET-specific fields from your schema
          shelfSpace: { $ifNull: ["$shelfSpace", "No Answer"] },
          designatedRack: { $ifNull: ["$designatedRack", "No Answer"] },
          beforeImage: { $ifNull: ["$beforeImage", ""] },
          afterImage: { $ifNull: ["$afterImage", ""] },
        },
      },
      {
        $sort: {
          date: 1,
          merchandiserName: 1,
        },
      },
    ]);

    console.log("Query Result:", data);
    console.log("Total VET records found:", data.length);

    if (data.length === 0) {
      return res.status(200).send({ status: 200, data: [] });
    }

    return res.send({ status: 200, data });
  } catch (error) {
    console.error("Aggregation Error:", error.message);
    return res.status(500).send({ error: error.message });
  }
});

// Competitors

app.post("/competitors/save", async (req, res) => {
  try {
    const {
      date,
      userEmail,
      merchandiser,
      outlet,
      store = "",
      company = "",
      brand = "",
      promoType = null,
      promoDetails = "",
      displayLocation = "",
      pricing = "",
      duration = "",
      impact = "",
      feedback = "",
    } = req.body;

    if (!date || !merchandiser || !outlet) {
      return res.status(400).json({
        message: "Missing required fields: date, merchandiser, or outlet",
      });
    }

    const competitorData = {
      date,
      userEmail,
      merchandiser,
      outlet,
      store,
      company,
      brand,
      promoType,
      promoDetails,
      displayLocation,
      pricing,
      duration,
      impact,
      feedback,
    };

    const competitor = new Competitors(competitorData);
    const result = await competitor.save();

    res.status(200).json({ message: "Data saved", id: result._id });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Competitors History

app.get("/competitors/history", async (req, res) => {
  try {
    const userEmail = req.query.email; // get email from query string

    if (!userEmail) {
      return res.status(400).json({ message: "Missing user email" });
    }

    // Find competitors documents filtered by userEmail, sorted by date desc
    const competitors = await Competitors.find({ userEmail })
      .sort({ date: -1 })
      .exec();

    res.status(200).json(competitors);
  } catch (error) {
    console.error("Error fetching competitors:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// COMPETITORS HISTORY ADMIN

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

app.post("/retrieve-competitor-data", async (req, res) => {
  try {
    const { branches } = req.body;

    console.log("Received branches:", JSON.stringify(branches));

    if (!branches || !Array.isArray(branches)) {
      return res
        .status(400)
        .json({ status: 400, message: "Invalid branch data" });
    }

    const branchPatterns = branches.map(
      (outlet) => new RegExp(`^${escapeRegExp(outlet.trim())}$`, "i")
    );

    const competitorsdata = await Competitors.find({
      outlet: { $in: branchPatterns },
    });

    console.log("Filtered Competitor Data:", competitorsdata.length);

    return res.status(200).json({ status: 200, data: competitorsdata });
  } catch (error) {
    console.error("Error retrieving competitors data:", error.stack);
    return res.status(500).json({ status: 500, error: "Server error" });
  }
});

// COMPETITORS EXPORT

app.post("/export-competitors-data", async (req, res) => {
  const { start, end } = req.body;

  try {
    const data = await mongoose.model("Competitor").aggregate([
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [{ $toDate: "$date" }, new Date(start)] },
              { $lte: [{ $toDate: "$date" }, new Date(end)] },
            ],
          },
        },
      },
      {
        $lookup: {
          from: "users", // assuming 'users' collection contains user profiles
          localField: "userEmail",
          foreignField: "email",
          as: "user_details",
        },
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: [{ $arrayElemAt: ["$user_details", 0] }, "$$ROOT"],
          },
        },
      },
      {
        $project: {
          _id: 0,
          date: 1,
          merchandiser: 1,
          outlet: 1,
          store: 1,
          company: 1,
          brand: 1,
          promoType: 1,
          promoDetails: 1,
          displayLocation: 1,
          pricing: 1,
          duration: 1,
          impact: 1,
          feedback: 1,
          user_first_name: "$first_name", // from joined user document
          user_last_name: "$last_name", // from joined user document
        },
      },
      {
        $sort: {
          date: 1,
          merchandiser: 1,
        },
      },
    ]);

    return res.send({ status: 200, data });
  } catch (error) {
    return res.status(500).send({ error: error.message });
  }
});

// EXPIRY

app.post("/expiry/save", async (req, res) => {
  try {
    const { date, merchandiser, outlet, expiryEntries, userEmail } = req.body;

    // Basic validation
    if (
      !date ||
      !merchandiser ||
      !outlet ||
      !userEmail ||
      !expiryEntries ||
      expiryEntries.length === 0
    ) {
      return res.status(400).json({ message: "All fields are required." });
    }

    for (let entry of expiryEntries) {
      if (!entry.month || !entry.sku || !entry.expiration) {
        return res.status(400).json({
          message: "Each expiry entry must have Month, SKU, and Expiration.",
        });
      }
    }

    const newExpiry = new Expiry({
      date,
      merchandiser,
      outlet,
      expiryEntries,
      userEmail,
    });

    await newExpiry.save();
    res.status(200).json({ message: "Expiry data saved successfully." });
  } catch (error) {
    console.error("Save error:", error);
    res.status(500).json({ message: "Server error while saving expiry data." });
  }
});

// EXPIRY HISTORY

app.get("/expiry/history", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ message: "Email is required" });

  try {
    const history = await Expiry.find({ userEmail: email }).sort({
      createdAt: -1,
    });
    res.json(history);
  } catch (err) {
    console.error("History fetch error:", err);
    res.status(500).json({ message: "Failed to fetch expiry history" });
  }
});

// EXPIRY DATA ADMIN

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

app.post("/retrieve-expiry-data", async (req, res) => {
  try {
    const { branches } = req.body;

    if (!branches || !Array.isArray(branches)) {
      return res
        .status(400)
        .json({ status: 400, message: "Invalid branch data" });
    }

    const branchPatterns = branches.map(
      (branch) => new RegExp(`^${escapeRegExp(branch.trim())}$`, "i")
    );

    const expirydata = await Expiry.find({
      outlet: {
        $in: branchPatterns,
      },
    });

    if (expirydata.length === 0) {
      return res.status(200).json({ status: 200, data: [] });
    }

    return res.status(200).json({ status: 200, data: expirydata });
  } catch (error) {
    return res.status(500).json({ status: 500, error: "Server error" });
  }
});

// EXPIRY EXPORT DATA

app.post("/export-Expiry-data", async (req, res) => {
  const { start, end } = req.body;
  console.log("Received Request:", { start, end });

  try {
    // Since date is stored as string in your schema, convert to string format for comparison
    const startDate = new Date(start).toISOString().split("T")[0]; // "2025-05-28"
    const endDate = new Date(end).toISOString().split("T")[0]; // "2025-05-28"

    console.log("Date range for comparison:", { startDate, endDate });

    const data = await mongoose.model("Expiry").aggregate([
      {
        $match: {
          date: { $gte: startDate, $lte: endDate }, // String comparison
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userEmail",
          foreignField: "email",
          as: "user_details",
        },
      },
      {
        $addFields: {
          merchandiserName: {
            $ifNull: [
              { $arrayElemAt: ["$user_details.name", 0] },
              "$merchandiser", // This field exists in your schema
            ],
          },
        },
      },
      {
        $project: {
          date: 1,
          merchandiserName: 1,
          outlet: 1,
          // Note: userType doesn't exist in your schema, so we'll set a default
          userType: { $literal: "Expiry" }, // Set a default value since it's not in schema
          // Note: version doesn't exist in your schema, so we'll set a default
          version: { $literal: "v1" }, // Set a default value since it's not in schema
          // Your schema has expiryEntries, not expiry
          expiryEntries: 1,
        },
      },
      {
        $sort: {
          date: 1,
          merchandiserName: 1,
        },
      },
    ]);

    console.log("Query results count:", data.length);
    if (data.length > 0) {
      console.log("Sample result:", JSON.stringify(data[0], null, 2));
    }

    if (data.length === 0) {
      return res.status(200).send({ status: 200, data: [] });
    }

    return res.send({ status: 200, data });
  } catch (error) {
    console.error("Aggregation Error:", error.message);
    return res.status(500).send({ error: error.message });
  }
});
// DATE PICKER FOR COMPETITORS

app.post("/filter-date-range-Expiry", async (req, res) => {
  const { startDate, endDate } = req.body;
  console.log("Filter range:", { startDate, endDate });

  try {
    const startDateString = new Date(startDate).toISOString().split("T")[0];
    const endDateString = new Date(endDate).toISOString().split("T")[0];

    console.log("Converted to date strings:", {
      startDateString,
      endDateString,
    });

    const expiryDataRange = await Expiry.find({
      date: {
        $gte: startDateString,
        $lte: endDateString,
      },
    });

    console.log("Found expiry data in range:", expiryDataRange.length);
    return res.status(200).json({ status: 200, data: expiryDataRange });
  } catch (error) {
    console.error("Error fetching expiry data:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

app.post("/filter-date-range-Conpetitor", async (req, res) => {
  const { startDate, endDate } = req.body;
  console.log("Filter range:", { startDate, endDate });

  try {
    // Convert the incoming ISO dates to YYYY-MM-DD format to match your database
    const startDateString = new Date(startDate).toISOString().split("T")[0];
    const endDateString = new Date(endDate).toISOString().split("T")[0];

    console.log("Converted to date strings:", {
      startDateString,
      endDateString,
    });

    const competitorsDataRange = await Competitors.aggregate([
      {
        $match: {
          date: {
            $gte: startDateString,
            $lte: endDateString,
          },
        },
      },
    ]);

    console.log("Found competitors in range:", competitorsDataRange.length);
    return res.status(200).json({ status: 200, data: competitorsDataRange });
  } catch (error) {
    console.error("Error fetching competitors:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

app.post("/filter-date-range-PSR", async (req, res) => {
  const { startDate, endDate } = req.body;
  console.log("Filter range:", { startDate, endDate });

  try {
    const startDateString = new Date(startDate).toISOString().split("T")[0];
    const endDateString = new Date(endDate).toISOString().split("T")[0];

    console.log("Converted to date strings:", {
      startDateString,
      endDateString,
    });

    const PSRDataRange = await QTTProcess.aggregate([
      {
        $match: {
          userType: "PSR", // <-- Only PSR
          date: {
            $gte: startDateString,
            $lte: endDateString,
          },
        },
      },
    ]);

    console.log("Found PSR in range:", PSRDataRange.length);
    return res.status(200).json({ status: 200, data: PSRDataRange });
  } catch (error) {
    console.error("Error fetching PSR:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

app.post("/filter-date-range-VET", async (req, res) => {
  const { startDate, endDate } = req.body;
  console.log("Filter range:", { startDate, endDate });

  try {
    const startDateString = new Date(startDate).toISOString().split("T")[0];
    const endDateString = new Date(endDate).toISOString().split("T")[0];

    console.log("Converted to date strings:", {
      startDateString,
      endDateString,
    });

    const VETDataRange = await QTTProcess.aggregate([
      {
        $match: {
          userType: "VET", // <-- Only VET
          date: {
            $gte: startDateString,
            $lte: endDateString,
          },
        },
      },
    ]);

    console.log("Found VET in range:", VETDataRange.length);
    return res.status(200).json({ status: 200, data: VETDataRange });
  } catch (error) {
    console.error("Error fetching VET:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

// ADMIN USERS

app.post("/get-admin-user", async (req, res) => {
  try {
    const users = await AdminUser.find(); // Returns all documents and fields
    return res.send({ status: 200, data: users });
  } catch (error) {
    return res.status(500).send({ error: error.message });
  }
});

// ADMIN REGISTRATION

app.post("/register-user-admin", async (req, res) => {
  const {
    firstName,
    middleName,
    lastName,
    emailAddress,
    contactNum,
    password,
    roleAccount,
    outlet,
    remarks,
  } = req.body;

  try {
    // Check if user already exists
    const existingUser = await AdminUser.findOne({ emailAddress });
    if (existingUser) {
      return res.send({ status: "error", message: "User already exists!" });
    }

    // Encrypt password
    const encryptedPassword = await bcrypt.hash(password, 8);

    // Determine type based on role (you can adjust logic if needed)
    // let type = 3; // Default type
    // if (roleAccount === "Admin") {
    //   type = 1;
    // }

    // Create new user
    const newUser = await AdminUser.create({
      firstName,
      middleName,
      lastName,
      emailAddress,
      contactNum,
      password: encryptedPassword,
      roleAccount,
      remarks: remarks || "",
      isVerified: false,
      outlet: outlet || [],
      // type,
    });

    res.send({ status: 200, message: "Admin user registered", user: newUser });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).send({ status: "error", message: error.message });
  }
});

// ADMIN USER OTP

app.post("/send-otp", async (req, res) => {
  const { email } = req.body;

  try {
    var code = Math.floor(100000 + Math.random() * 900000);
    code = String(code);
    code = code.substring(0, 4);

    const info = await transporter.sendMail({
      from: {
        name: "BMPower",
        address: process.env.EMAIL_USER,
      },
      to: email,
      subject: "OTP code",
      html:
        "<b>Your OTP code is</b> " +
        code +
        "<b>. Do not share this code with others.</b>",
    });

    return res.send({ status: 200, code: code });
  } catch (error) {
    return res.send({ error: error.message });
  }
});

// ADMIN USER UPDATE STATUS

app.put("/update-admin-status", async (req, res) => {
  const { isVerified, emailAddress } = req.body;

  try {
    const updatedUser = await AdminUser.findOneAndUpdate(
      { emailAddress },
      { $set: { isVerified: isVerified } },
      { new: true }
    );

    if (!updatedUser) {
      return res
        .status(404)
        .send({ status: "error", message: "User not found" });
    }

    res.send({ status: 200, message: "Status updated", user: updatedUser });
  } catch (error) {
    res.status(500).send({ status: "error", message: error.message });
  }
});

// ADMIN USER UPDATE OUTLET

app.put("/update-admin-outlet", async (req, res) => {
  const { emailAddress, outlet } = req.body;

  try {
    const updatedUser = await AdminUser.findOneAndUpdate(
      { emailAddress },
      { $set: { outlet } },
      { new: true }
    );

    if (!updatedUser) {
      return res
        .status(404)
        .send({ status: "error", message: "User not found" });
    }

    res.send({
      status: 200,
      message: "User branches updated",
      user: updatedUser,
    });
  } catch (error) {
    res.status(500).send({ status: "error", message: error.message });
  }
});

// USERS

app.post("/get-all-user", async (req, res) => {
  try {
    const users = await User.find(); // No projection — returns all fields
    return res.send({ status: 200, data: users });
  } catch (error) {
    return res.status(500).send({ error: error.message });
  }
});

// UPDATE USERS OUTLET
app.put("/update-user-branch", async (req, res) => {
  const { email, outlet } = req.body;

  try {
    const updatedUser = await User.findOneAndUpdate(
      { email },
      { $set: { outlet } }, // No need to join, just save the array
      { new: true }
    );

    if (!updatedUser) {
      return res
        .status(404)
        .send({ status: "error", message: "User not found" });
    }

    res.send({ status: 200, data: "User branches updated", user: updatedUser });
  } catch (error) {
    res.status(500).send({ status: "error", message: error.message });
  }
});

// ADMIN LOGIN

app.post("/login-admin", async (req, res) => {
  const { emailAddress, password } = req.body;

  try {
    const user = await AdminUser.findOne({ emailAddress });

    if (!user) {
      return res.status(401).json({
        status: 401,
        data: "Email address not found",
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        status: 401,
        data: "Incorrect password",
      });
    }

    // Login success
    return res.status(200).json({
      status: 200,
      data: {
        firstName: user.firstName,
        lastName: user.lastName,
        roleAccount: user.roleAccount,
        outlet: user.outlet,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      status: 500,
      data: "Internal server error",
    });
  }
});

//SIGN UP

app.post("/signup", async (req, res) => {
  const {
    role,
    outlet,
    firstName,
    middleName,
    lastName,
    email,
    contactNumber,
    password,
  } = req.body;

  // Check if user already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ message: "Email already registered" });
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  // Create new user with isVerified set to false
  const newUser = new User({
    role, // Include role
    outlet,
    firstName,
    middleName,
    lastName,
    email,
    contactNumber,
    password: hashedPassword,
    isVerified: false,
  });

  await newUser.save();

  // Generate and send OTP (6 digits only)
  const otp = Math.floor(100000 + Math.random() * 900000).toString(); // Generates a 6-digit number
  const newOtp = new Otp({ email, otp });
  await newOtp.save();
  await sendEmail(
    email,
    "Your OTP Code",
    `Your OTP is ${otp}. It will expire in 5 minutes.`
  );

  res.status(201).json({ message: "User registered. OTP sent to email." });
});

// FORGOT PASSWORD

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) return res.status(404).json({ message: "User not found" });

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save OTP in the Otp collection with purpose "reset-password"
    await Otp.create({
      email,
      otp,
      purpose: "reset-password",
      createdAt: new Date(),
    });

    // Send OTP via email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "Password Reset OTP",
      text: `Your OTP is: ${otp}`,
    });

    res.status(200).json({ message: "OTP sent to email" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to send OTP" });
  }
});

// VERIFY OTP

app.post("/verify-otp", async (req, res) => {
  const { email, otp, purpose } = req.body;

  const otpEntry = await Otp.findOne({ email, otp, purpose });
  if (!otpEntry) {
    return res.status(400).json({ message: "Invalid or expired OTP" });
  }

  if (purpose === "verify-email") {
    await User.updateOne({ email }, { isVerified: true });
  }

  // For reset-password, don’t delete OTP yet. Just return success.
  if (purpose === "verify-email") {
    await Otp.deleteOne({ _id: otpEntry._id });
  }

  return res.status(200).json({ message: "OTP verified successfully" });
});

const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendEmail = async (to, subject, text) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
  };
  await transporter.sendMail(mailOptions);
};

// RESET PASSWORD

app.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res.status(200).json({ message: "Password has been reset successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Reset failed" });
  }
});

//PROFILE

app.get("/profile", authMiddleware, async (req, res) => {
  try {
    // req.user is set by authMiddleware after verifying token
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

//LOGIN

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const payload = {
      user: {
        id: user.id,
        email: user.email, // ✅ added for middleware
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "5h" },
      (err, token) => {
        if (err) throw err;
        res.json({
          token,
          user: {
            id: user._id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            outlet: user.outlet,
            role: user.role,
          },
        });
      }
    );
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: "Server error" });
  }
});

// Auth

app.get("/auth", authMiddleware, async (req, res) => {
  try {
    // req.user is set by authMiddleware after verifying token
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err) {
    console.error("Profile error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
