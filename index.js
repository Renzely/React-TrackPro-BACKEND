require("node:dns/promises").setServers(["1.1.1.1", "8.8.8.8"]);
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const AWS = require("aws-sdk");
const app = express();
app.use(cors());
app.use(express.json());
const Attendance = require("./attendance");
const auth = require("./auth");
const bcrypt = require("bcryptjs");
const User = require("./users");
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

// function parsePhilippineDateTimeAlternative(dateStr, timeStr) {
//   const baseDate = new Date(dateStr);

//   const timeStrTrimmed = timeStr.trim().replace(/\s+/g, " ");
//   const [time, period] = timeStrTrimmed.split(" ");

//   const [hours, minutes] = time.split(":");

//   let hour24 = parseInt(hours);

//   if (period?.toLowerCase() === "pm" && hour24 !== 12) {
//     hour24 += 12;
//   } else if (period?.toLowerCase() === "am" && hour24 === 12) {
//     hour24 = 0;
//   }

//   const year = baseDate.getFullYear();
//   const month = baseDate.getMonth();
//   const day = baseDate.getDate();

//   // Create the datetime string in Philippine timezone format
//   const isoString = `${year}-${String(month + 1).padStart(2, "0")}-${String(
//     day
//   ).padStart(2, "0")}T${String(hour24).padStart(2, "0")}:${String(
//     parseInt(minutes)
//   ).padStart(2, "0")}:00.000+08:00`;

//   return new Date(isoString);
// }

// For your date field, also fix it to be in Philippine timezone
function createPhilippineAttendanceDate(input) {
  const base = typeof input === "string" ? new Date(input) : input;
  const phTime = dayjs(base).tz("Asia/Manila");
  return phTime.format("YYYY-MM-DD");
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

    // Always get PH-local date (reset at 12AM PH time)
    const now = dayjs().tz("Asia/Manila");
    const dateObj = now.format("YYYY-MM-DD");

    const timeInObj = parsePhilippineDateTimeAlternative(dateObj, timeIn);
    const timeInFormatted = dayjs(timeInObj)
      .tz("Asia/Manila")
      .format("dddd, MMMM D, YYYY [at] h:mm A");

    console.log("Original timeIn string:", timeIn);
    console.log("Parsed Philippine time:", timeInObj.toString());
    console.log("Philippine time ISO:", timeInObj.toISOString());

    let attendance = await Attendance.findOne({ email, date: dateObj });

    const timeLogData = {
      outlet,
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
    };

    if (attendance) {
      const existingTimeLog = attendance.timeLogs.find(
        (log) => log.outlet === outlet,
      );

      if (existingTimeLog) {
        existingTimeLog.timeIn = timeLogData.timeIn;
        existingTimeLog.timeInLocation = timeLogData.timeInLocation;
        existingTimeLog.timeInCoordinates = timeLogData.timeInCoordinates;
        existingTimeLog.timeInSelfieUrl = timeLogData.timeInSelfieUrl;
      } else {
        attendance.timeLogs.push(timeLogData);
      }
    } else {
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

    const now = dayjs().tz("Asia/Manila");
    const dateObj = now.format("YYYY-MM-DD");

    const timeOutObj = parsePhilippineDateTimeAlternative(dateObj, timeOut);
    const timeOutFormatted = dayjs(timeOutObj)
      .tz("Asia/Manila")
      .format("dddd, MMMM D, YYYY [at] h:mm A");

    console.log("Original timeOut string:", timeOut);
    console.log("Parsed Philippine time:", timeOutObj.toString());

    const attendance = await Attendance.findOne({ email, date: dateObj });

    if (!attendance) {
      return res.status(404).json({ error: "Attendance record not found." });
    }

    const lastTimeLog = [...attendance.timeLogs]
      .reverse()
      .find((log) => log.outlet === outlet && !log.timeOut);

    if (!lastTimeLog) {
      return res.status(404).json({
        error: "No corresponding time-in record found for this outlet.",
      });
    }

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
    const dateObj = createPhilippineAttendanceDate(new Date());
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

    const log = attendance.timeLogs.find((log) => {
      if (outlet === "Others") {
        // Match any "Others: ..." outlet
        return log.outlet.startsWith("Others:");
      }
      return log.outlet === outlet;
    });

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
// Attendance Export
app.post("/get-attendance", async (req, res) => {
  try {
    const { email, start: startRaw, end: endRaw } = req.body;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email required" });
    }

    const dateRange = {};
    if (startRaw) {
      const startDate = new Date(startRaw).toISOString().split("T")[0]; // "YYYY‑MM‑DD"
      dateRange.$gte = startDate;
    }
    if (endRaw) {
      const endDate = new Date(endRaw).toISOString().split("T")[0]; // "YYYY‑MM‑DD"
      dateRange.$lte = endDate;
    }

    console.log("Date range:", dateRange); // helpful for debugging

    // Build main Mongo query
    const query = { email };
    if (Object.keys(dateRange).length) {
      query.date = dateRange; // <-- filter on `date`, not `createdAt`
    }

    const records = await Attendance.find(query).sort({ date: 1 });

    if (!records.length) {
      return res.json({ success: true, data: [] });
    }

    let counter = 1;
    const flat = records.flatMap((att) =>
      att.timeLogs.map((log) => ({
        count: counter++,
        email: att.email,
        date: att.date, // keep the original display date
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
    `Your OTP is ${otp}. It will expire in 5 minutes.`,
  );

  res.status(201).json({ message: "User registered. OTP sent to email." });
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

    if (!user.isVerified) {
      return res.status(403).json({
        message:
          "Your account is inactive. Please contact your Account Supervisor to activate your account.",
      });
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
      { expiresIn: "180d" }, // 6-month token
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
