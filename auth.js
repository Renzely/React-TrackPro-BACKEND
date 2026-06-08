const jwt = require("jsonwebtoken");
require("dotenv").config();

module.exports = function (req, res, next) {
  const authHeader = req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "Authorization header missing or malformed" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || !decoded.user || !decoded.user.email) {
      return res.status(400).json({ message: "Invalid token payload" });
    }

    // ── TEMPORARY DEBUG LOG ──────────────────────────────────────────────
    console.log("✅ Token valid for:", decoded.user.email, {
      issuedAt: new Date(decoded.iat * 1000).toISOString(),
      expiresAt: decoded.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : "NO EXPIRY",
      secondsRemaining: decoded.exp
        ? decoded.exp - Math.floor(Date.now() / 1000)
        : "N/A",
    });
    // ─────────────────────────────────────────────────────────────────────

    req.user = decoded.user;
    next();
  } catch (err) {
    // ── TEMPORARY DEBUG LOG ──────────────────────────────────────────────
    console.error("❌ Token verification FAILED:", err.message, {
      tokenPreview: token?.substring(0, 20) + "...",
    });
    // ─────────────────────────────────────────────────────────────────────
    return res.status(401).json({ message: "Token is not valid" });
  }
};
