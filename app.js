const express = require("express");
const cookieParser = require("cookie-parser");

require("dotenv").config();

const database = require("./config/database");
const corsConfig = require("./config/cors");

const routesApiV1Client = require("./api/v1/routes/client/index.route");
const routesApiV1Admin = require("./api/v1/routes/admin/index.route");

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(corsConfig);
app.options(/.*/, corsConfig);

// Connect DB trước routes
let isDbConnected = false;
app.use(async (req, res, next) => {
  try {
    if (!isDbConnected) {
      await database.connect();
      isDbConnected = true;
    }
    next();
  } catch (err) {
    console.error("DB connect failed:", err);
    res.status(500).json({ message: "Database connection failed" });
  }
});

// Routes
routesApiV1Client(app);
routesApiV1Admin(app);

module.exports = app;