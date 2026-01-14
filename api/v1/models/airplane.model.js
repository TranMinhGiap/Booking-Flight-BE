const mongoose = require("mongoose");

const AirplaneSchema = new mongoose.Schema(
  {
    airlineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Airline",
      required: true,
      index: true,
    },
    registrationNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9-]{3,15}$/,
    },
    model: { type: String, trim: true, required: true },
    totalSeats: { type: Number, default: 0, min: 0, max: 1000 },

    deleted: { type: Boolean, default: false, index: true },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Airplane", AirplaneSchema, "airplanes");
