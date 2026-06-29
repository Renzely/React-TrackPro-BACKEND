require("node:dns/promises").setServers(["1.1.1.1", "8.8.8.8"]);
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const AWS = require("aws-sdk");
const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cors());
app.use(express.json());
const Attendance = require("./attendance");
const auth = require("./auth");
const bcrypt = require("bcryptjs");
const User = require("./users");
const PendingUser = require("./pendingUser");
const AdminUser = require("./adminUsers");
const authMiddleware = require("./auth");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const nodemailer = require("nodemailer");
const Otp = require("./otp");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

function parsePhilippineDateTimeAlternative(dateStr, timeStr) {
  const dateTimeStr = `${dateStr} ${timeStr}`;

  // Parse using dayjs in Asia/Manila timezone
  const phTime = dayjs.tz(dateTimeStr, "YYYY-MM-DD h:mm A", "Asia/Manila");

  if (!phTime.isValid()) {
    console.error("❌ Invalid PH datetime parse:", dateStr, timeStr);
    return new Date("Invalid");
  }

  // Convert to Date object while keeping the correct local time (Asia/Manila)
  return new Date(phTime.toISOString()); // ← Safe for MongoDB, stores UTC with PH meaning
}

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

// For your date field, also fix it to be in Philippine timezone
function createPhilippineAttendanceDate(input) {
  const base = typeof input === "string" ? new Date(input) : input;
  const phTime = dayjs(base).tz("Asia/Manila");
  return phTime.format("YYYY-MM-DD");
}

const manilaDate = (offsetDays = 0) =>
  dayjs().tz("Asia/Manila").add(offsetDays, "day").format("YYYY-MM-DD");

async function resolveBusinessDate(email, outlet) {
  const prev = await Attendance.findOne({ email, date: manilaDate(-1) });
  const openGrave = prev?.timeLogs.find(
    (l) =>
      l.outlet === outlet &&
      l.shiftType === "graveyard" &&
      l.timeIn &&
      !l.timeOut,
  );
  return openGrave ? manilaDate(-1) : manilaDate(0);
}

async function findOpenLogDoc(email, outlet) {
  for (const d of [manilaDate(0), manilaDate(-1)]) {
    const doc = await Attendance.findOne({ email, date: d });
    const open =
      doc &&
      [...doc.timeLogs]
        .reverse()
        .find((l) => l.outlet === outlet && l.timeIn && !l.timeOut);
    if (open) return { doc, log: open, date: d };
  }
  return null;
}

// Updated endpoint code
app.post("/attendance/time-in", async (req, res) => {
  try {
    console.log("Received /attendance/time-in request with body:", req.body);

    const {
      email,
      date,
      outlet,
      timeIn,
      selfieUrl,
      location,
      timeInLocation,
      shiftType,
    } = req.body;

    if (
      !email ||
      !date ||
      !outlet ||
      !timeIn ||
      !selfieUrl ||
      typeof location?.latitude !== "number" ||
      typeof location?.longitude !== "number"
    ) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const dateObj = await resolveBusinessDate(email, outlet);

    const timeInObj = parsePhilippineDateTimeAlternative(dateObj, timeIn);
    const timeInFormatted = dayjs(timeInObj)
      .tz("Asia/Manila")
      .format("dddd, MMMM D, YYYY [at] h:mm A");

    let attendance = await Attendance.findOne({ email, date: dateObj });

    if (!attendance) {
      attendance = new Attendance({ email, date: dateObj, timeLogs: [] });
    }

    // ✅ Get all logs for this outlet
    const outletLogs = attendance.timeLogs.filter((l) => l.outlet === outlet);

    // ✅ Max 3 shifts per outlet
    if (outletLogs.length >= 3) {
      return res
        .status(400)
        .json({ error: "Maximum 3 shifts per outlet reached." });
    }

    // ✅ Must time out first before starting a new shift
    const openLog = outletLogs.find((l) => l.timeIn && !l.timeOut);
    if (openLog) {
      return res
        .status(400)
        .json({ error: "Please Time Out first before starting a new shift." });
    }

    // ✅ Always push a new log (never overwrite)
    attendance.timeLogs.push({
      outlet,
      shiftType: shiftType === "graveyard" ? "graveyard" : "day",
      timeIn: timeInObj,
      timeInPHString: timeInFormatted,
      timeInLocation:
        timeInLocation ||
        `Lat: ${location.latitude}, Long: ${location.longitude}`,
      timeInCoordinates: {
        latitude: location.latitude,
        longitude: location.longitude,
      },
      timeInSelfieUrl: selfieUrl,
    });

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

    // ── CHANGED: find the doc that actually holds the open shift
    //    (covers a graveyard shift that started yesterday)
    const found = await findOpenLogDoc(email, outlet);
    if (!found) {
      return res.status(404).json({
        error: "No corresponding time-in record found for this outlet.",
      });
    }
    const { doc: attendance, log: lastTimeLog, date: dateObj } = found;
    // ── END CHANGED

    const timeOutObj = parsePhilippineDateTimeAlternative(dateObj, timeOut);
    const timeOutFormatted = dayjs(timeOutObj)
      .tz("Asia/Manila")
      .format("dddd, MMMM D, YYYY [at] h:mm A");

    console.log("Original timeOut string:", timeOut);
    console.log("Parsed Philippine time:", timeOutObj.toString());

    lastTimeLog.timeOut = timeOutObj;
    lastTimeLog.timeOutPHString = timeOutFormatted;
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
    const dateObj = await resolveBusinessDate(email, outlet);
    const attendance = await Attendance.findOne({ email, date: dateObj });

    const empty = {
      hasTimedIn: false,
      hasTimedOut: false,
      timeInTimestamp: null,
      timeOutTimestamp: null,
      addressTimeIn: null,
      addressTimeOut: null,
      timeInSelfieUri: null,
      timeOutSelfieUri: null,
      shiftCount: 0,
      canAddShift: true,
      activeShiftType: null,
    };

    if (!attendance) return res.json(empty);

    // ✅ All logs for this outlet
    const outletLogs = attendance.timeLogs.filter((l) => l.outlet === outlet);
    const shiftCount = outletLogs.length;

    if (shiftCount === 0) return res.json(empty);

    const activeLog =
      outletLogs.find((l) => l.timeIn && !l.timeOut) ??
      outletLogs[outletLogs.length - 1]; // fallback to last log

    const lastLog = outletLogs[outletLogs.length - 1];
    const lastLogCompleted = !!(lastLog?.timeIn && lastLog?.timeOut);
    const openLog = outletLogs.find((l) => l.timeIn && !l.timeOut);

    return res.json({
      hasTimedIn: !!activeLog.timeIn,
      hasTimedOut: !!activeLog.timeOut,
      timeInTimestamp: activeLog.timeIn || null,
      timeOutTimestamp: activeLog.timeOut || null,
      addressTimeIn: activeLog.timeInLocation || null,
      addressTimeOut: activeLog.timeOutLocation || null,
      timeInSelfieUri: activeLog.timeInSelfieUrl || null,
      timeOutSelfieUri: activeLog.timeOutSelfieUrl || null,
      shiftCount, // ✅ 1, 2, or 3
      canAddShift: lastLogCompleted && shiftCount < 3, // ✅ true if can start new shift
      activeShiftType: openLog?.shiftType ?? null,
    });
  } catch (err) {
    console.error("Error fetching attendance status:", err);
    return res.status(500).json({ error: "Failed to fetch attendance status" });
  }
});

// ✅ New batch endpoint — add this alongside your existing /attendance/status
app.post("/attendance/batch-status", async (req, res) => {
  const { users, date } = req.body;
  // users = [{ email, outlets: ["outlet1", "outlet2"] }, ...]

  try {
    const dateObj = createPhilippineAttendanceDate(new Date());

    // ✅ Fetch all attendance records for all emails in ONE query
    const emails = users.map((u) => u.email);
    const attendances = await Attendance.find({
      email: { $in: emails },
      date: dateObj,
    });

    // ✅ Map by email for fast lookup
    const attendanceMap = {};
    attendances.forEach((a) => {
      attendanceMap[a.email] = a;
    });

    // ✅ Build response for each user
    // In your batch-status endpoint, update the results.map to include shiftCount
    const results = users.map(({ email, outlets }) => {
      const attendance = attendanceMap[email];

      if (!attendance) {
        return {
          email,
          hasTimedIn: false,
          hasTimedOut: false,
          timeInTimestamp: null,
          timeOutTimestamp: null,
          outlet: null,
          shiftCount: 0,
          completedShifts: 0,
        };
      }

      let bestLog = null;
      let bestOutlet = null;
      let totalShiftCount = 0;
      let completedShifts = 0;

      for (const outlet of outlets) {
        const outletLogs = attendance.timeLogs.filter(
          (l) => l.outlet === outlet,
        );
        totalShiftCount += outletLogs.length;
        completedShifts += outletLogs.filter(
          (l) => l.timeIn && l.timeOut,
        ).length;

        for (const log of outletLogs) {
          if (log?.timeIn) {
            if (!bestLog || new Date(log.timeIn) > new Date(bestLog.timeIn)) {
              bestLog = log;
              bestOutlet = outlet;
            }
          }
        }
      }

      if (!bestLog) {
        return {
          email,
          hasTimedIn: false,
          hasTimedOut: false,
          timeInTimestamp: null,
          timeOutTimestamp: null,
          outlet: outlets[0],
          shiftCount: totalShiftCount,
          completedShifts,
        };
      }

      return {
        email,
        hasTimedIn: !!bestLog.timeIn,
        hasTimedOut: !!bestLog.timeOut,
        timeInTimestamp: bestLog.timeIn || null,
        timeOutTimestamp: bestLog.timeOut || null,
        addressTimeIn: bestLog.timeInLocation || null,
        addressTimeOut: bestLog.timeOutLocation || null,
        timeInCoordinates: bestLog.timeInCoordinates || null, // ✅ needed for map
        timeOutCoordinates: bestLog.timeOutCoordinates || null, // ✅ needed for map
        outlet: bestOutlet,
        shiftCount: totalShiftCount,
        completedShifts, // ✅ e.g. 2 means 2 full time-in + time-out pairs
      };
    });
    return res.json({ data: results });
  } catch (err) {
    console.error("Batch attendance error:", err);
    return res.status(500).json({ error: "Failed to fetch batch attendance" });
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
// Attendance Export
app.post("/get-attendance", async (req, res) => {
  try {
    const { email, start: startRaw, end: endRaw } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email required" });
    }

    // ✅ Fetch user role alongside attendance
    const user = await User.findOne({ email });
    const userRole = user?.role ?? "N/A";

    const dateRange = {};
    if (startRaw)
      dateRange.$gte = new Date(startRaw).toISOString().split("T")[0];
    if (endRaw) dateRange.$lte = new Date(endRaw).toISOString().split("T")[0];

    const query = { email };
    if (Object.keys(dateRange).length) query.date = dateRange;

    const records = await Attendance.find(query).sort({ date: 1 });

    if (!records.length) return res.json({ success: true, data: [] });

    let counter = 1;
    const flat = records.flatMap((att) =>
      att.timeLogs.map((log) => ({
        count: counter++,
        email: att.email,
        role: userRole, // ✅ added
        date: att.date,
        outlet: log.outlet ?? "",
        timeIn: log.timeIn ?? null,
        timeOut: log.timeOut ?? null,
        hasTimedIn: Boolean(log.timeIn),
        hasTimedOut: Boolean(log.timeOut),
        timeInLocation: log.timeInLocation ?? "No location provided",
        timeOutLocation: log.timeOutLocation ?? "No location provided",
        timeInCoordinates: log.timeInCoordinates ?? {
          latitude: 0,
          longitude: 0,
        },
        timeOutCoordinates: log.timeOutCoordinates ?? {
          latitude: 0,
          longitude: 0,
        },
        timeInSelfieUrl: log.timeInSelfieUrl ?? "",
        timeOutSelfieUrl: log.timeOutSelfieUrl ?? "",
      })),
    );

    res.json({ success: true, data: flat });
  } catch (err) {
    console.error("Error in /get-attendance:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
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
      { new: true },
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
      { new: true },
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

// UPDATE USER STATUS

app.put("/update-user-status", async (req, res) => {
  const { email, isVerified } = req.body;

  if (!email || typeof isVerified !== "boolean") {
    return res.status(400).send({
      status: "error",
      data: "Missing or invalid email / isVerified",
    });
  }

  try {
    const result = await User.findOneAndUpdate(
      { email: email },
      { $set: { isVerified: isVerified } },
      { new: true },
    );

    if (!result) {
      return res.status(404).send({
        status: "error",
        data: "User not found",
      });
    }

    console.log("Updated user:", result);
    res.send({
      status: 200,
      data: "Status updated",
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      status: "error",
      data: error.message,
    });
  }
});

// UPDATE USERS OUTLET
app.put("/update-user-branch", async (req, res) => {
  const { email, outlet } = req.body;

  try {
    const updatedUser = await User.findOneAndUpdate(
      { email },
      { $set: { outlet } }, // No need to join, just save the array
      { new: true },
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

  // Block if already a real verified account
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).json({ message: "Email already registered" });
  }

  // Clean up any previous pending registration for this email
  await PendingUser.deleteOne({ email });
  await Otp.deleteOne({ email });

  const hashedPassword = await bcrypt.hash(password, 10);

  // ✅ Save to PendingUser, NOT User
  await PendingUser.create({
    role,
    outlet,
    firstName,
    middleName,
    lastName,
    email,
    contactNumber,
    password: hashedPassword,
  });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await Otp.create({ email, otp, purpose: "verify-email" });
  await sendEmail(
    email,
    "Your OTP Code",
    `Your OTP is ${otp}. It will expire in 5 minutes.`,
  );

  res.status(201).json({
    message: "OTP sent to email. Please verify to complete registration.",
  });
});
// FORGOT PASSWORD ADMIN

app.post("/send-otp-forgotpassword", async (req, res) => {
  const { emailAddress } = req.body;

  const oldUser = await AdminUser.findOne({ emailAddress: emailAddress });

  if (!oldUser) {
    return res.status(404).json({ error: "Email does not exist" });
  }

  try {
    var code = Math.floor(100000 + Math.random() * 900000);
    code = String(code);
    code = code.substring(0, 4);

    const info = await transporter.sendMail({
      from: {
        name: "BMPower",
        address: process.env.EMAIL_USER,
      },
      to: emailAddress,
      subject: "OTP code",
      html:
        "<b>Your OTP code is</b> " +
        code +
        "<b>. Do not share this code with others.</b>",
    });

    return res.status(200).json({
      status: 200,
      data: info,
      emailAddress: emailAddress,
      code: code,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ error: "Failed to send OTP. Please try again." });
  }
});

app.put("/forgot-password-reset", async (req, res) => {
  const { password, emailAddress } = req.body;

  const encryptedPassword = await bcrypt.hash(password, 8);

  console.log(emailAddress);
  try {
    await AdminUser.findOneAndUpdate(
      { emailAddress: emailAddress },
      { $set: { password: encryptedPassword } },
    );
    res.send({ status: 200, data: "Password updated" });
  } catch (error) {
    res.send({ status: "error", data: error });
  }
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
    // ✅ Grab the pending data
    const pending = await PendingUser.findOne({ email });
    if (!pending) {
      return res
        .status(400)
        .json({ message: "Registration expired. Please sign up again." });
    }

    // ✅ NOW create the real account
    await User.create({
      role: pending.role,
      outlet: pending.outlet,
      firstName: pending.firstName,
      middleName: pending.middleName,
      lastName: pending.lastName,
      email: pending.email,
      contactNumber: pending.contactNumber,
      password: pending.password, // already hashed
      isVerified: false, // supervisor still needs to activate
    });

    // Clean up
    await PendingUser.deleteOne({ email });
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

    // ✅ Check verification BEFORE password — prevents password probing
    if (!user.isVerified) {
      return res.status(403).json({
        message:
          "Your account is inactive. Please contact your Account Supervisor to activate your account.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const payload = {
      user: {
        id: user.id,
        email: user.email,
      },
    };

    jwt.sign(
      payload,
      process.env.JWT_SECRET,
      { expiresIn: "180d" },
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
            // ✅ isVerified removed — no need to expose it to the client
          },
        });
      },
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
