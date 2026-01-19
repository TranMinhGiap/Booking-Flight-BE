const mongoose = require("mongoose");

const FlightSchema = new mongoose.Schema(
  {
    airlineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Airline",
      required: true,
      index: true,
    },

    // Ví dụ format: VN123, VJ12, TG401...
    flightNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9]{2,3}\d{1,4}$/,
    },

    departureAirportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Airport",
      required: true,
      index: true,
    },

    arrivalAirportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Airport",
      required: true,
      index: true,
    },

    durationMinutes: {
      type: Number,
      required: true,
      min: 1,
      max: 24 * 60,
    },

    deleted: { type: Boolean, default: false, index: true },

    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

// Không cho departure = arrival
FlightSchema.pre("validate", function () {
  if (
    this.departureAirportId &&
    this.arrivalAirportId &&
    this.departureAirportId.toString() === this.arrivalAirportId.toString()
  ) {
    throw new Error("departureAirportId must be different from arrivalAirportId");
  }
});


// Index phục vụ query tuyến bay nhanh
FlightSchema.index({ departureAirportId: 1, arrivalAirportId: 1, airlineId: 1 });

// Unique flightNumber theo airline (và chỉ áp dụng cho record chưa bị soft delete)
FlightSchema.index(
  { airlineId: 1, flightNumber: 1 },
  { unique: true, partialFilterExpression: { deleted: false } }
);

module.exports = mongoose.model("Flight", FlightSchema, "flights");