const cors = require("cors");

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    // cho phép request không có origin (Postman, curl, server-to-server)
    if (!origin) return cb(null, true);

    const allow = allowedOrigins.includes(origin);

    if (!allow) console.warn("[CORS] Blocked origin:", origin);

    cb(null, allow);
  },
  credentials: true, // bật nếu FE gửi cookie / Authorization cần chia sẻ
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["Content-Length"], // thêm nếu FE cần đọc header custom
  maxAge: 86400, // cache preflight 24h
};

module.exports = cors(corsOptions);
