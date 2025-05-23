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
const multer = require("multer");
const multerS3 = require("multer-s3");
require("dotenv").config();

const nodemailer = require("nodemailer");
const Otp = require("./otp");

// MongoDB Atlas connection
const uri =
  "mongodb+srv://NewClientApp:NewClientAppPass@towi.v2djp3n.mongodb.net/ReactRC_UGC?retryWrites=true&w=majority&appName=TOWI";

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

function parseDateTime(dateStr, timeStr) {
  const date = new Date(dateStr);

  const dateTimeStr = `${dateStr} ${timeStr}`;
  const dateTime = new Date(dateTimeStr);

  if (isNaN(dateTime)) {
    return date;
  }
  return dateTime;
}

// Route to handle time-in
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

    const dateObj = new Date(date);
    const timeInObj = parseDateTime(date, timeIn);

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

// Route to handle time-out
app.post("/attendance/time-out", async (req, res) => {
  try {
    const {
      email,
      date,
      outlet,
      timeOut,
      timeOutSelfieUrl,
      location,
      timeOutLocation, // optional from client
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

    const dateObj = new Date(date);
    const timeOutObj = parseDateTime(date, timeOut);

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
    const dateObj = new Date(date);
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

// DATE PICKER

app.post("/filter-date-range", async (req, res) => {
  const { startDate, endDate } = req.body;
  console.log("Filter range:", { startDate, endDate });

  try {
    const inventoryInRange = await Inventory.find({
      date: { $gte: startDate, $lte: endDate },
    });

    console.log("Found inventory in range:", inventoryInRange);
    return res.status(200).json({ status: 200, data: inventoryInRange });
  } catch (error) {
    console.error("Error fetching inventory:", error);
    return res.status(500).send({ error: "Internal Server Error" });
  }
});

app.post("/export-inventory-towi", async (req, res) => {
  const { start, end } = req.body;

  try {
    const data = await Inventory.aggregate([
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [{ $toDate: "$date" }, new Date(start)] },
              { $lt: [{ $toDate: "$date" }, new Date(end)] },
            ],
          },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "email",
          foreignField: "email",
          as: "user_details",
        },
      },
      {
        $unwind: {
          path: "$user_details",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          date: 1,
          merchandiser: 1,
          outlet: 1,
          weeksCovered: 1,
          month: 1,
          week: 1,
          locked: 1,
          versions: 1,
        },
      },
    ]);

    const formatted = [];

    data.forEach((record, index) => {
      ["V1", "V2", "V3"].forEach((versionKey) => {
        const version = record.versions?.[versionKey];
        if (!version) return;

        ["Carried", "Not Carried", "Delisted"].forEach((status) => {
          const skuList = version[status] || [];

          skuList.forEach((sku) => {
            formatted.push({
              count: formatted.length + 1,
              date: record.date,
              fullname: record.merchandiser || "N/A",
              outlet: record.outlet,
              weeksCovered: record.weeksCovered,
              month: record.month,
              week: record.week,
              sku: sku.sku,
              skuCode: sku.skuCode,
              status,
              beginning:
                status === "Carried"
                  ? sku.beginningPCS || 0
                  : status === "Not Carried"
                  ? "NC"
                  : "Delisted",
              delivery: status === "Carried" ? sku.deliveryPCS || 0 : "",
              ending: status === "Carried" ? sku.endingPCS || 0 : "",
              offtake: status === "Carried" ? sku.offtake || 0 : "",
              inventoryDaysLevel:
                status === "Carried" ? sku.inventoryDays || 0 : "",
              expiryMonth: status === "Carried" ? sku.expiryMonths || "" : "",
              expiryQty: status === "Carried" ? sku.expiryQty || 0 : "",
            });
          });
        });
      });
    });

    return res.send({ status: 200, data: formatted });
  } catch (error) {
    console.error("Error exporting inventory data:", error);
    return res.status(500).send({ error: error.message });
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
