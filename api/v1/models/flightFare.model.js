const mongoose = require("mongoose");

const FlightFareSchema = new mongoose.Schema(
  {
    flightScheduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlightSchedule",
      required: true,
      index: true,
    },
    seatClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SeatClass",
      required: true,
      index: true,
    },
    basePrice: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    serviceFee: { type: Number, default: 0, min: 0 },

    deleted: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique fare per class per flight
FlightFareSchema.index(
  { flightScheduleId: 1, seatClassId: 1 },
  { unique: true, partialFilterExpression: { deleted: false }, name: "idx_unique_fare" }
);

// Query active fares
FlightFareSchema.index(
  { flightScheduleId: 1, seatClassId: 1, deleted: 1 },
  { name: "idx_schedule_class_active" }
);

// Virtual tổng giá
FlightFareSchema.virtual("totalPrice").get(function () {
  return this.basePrice + this.tax + this.serviceFee;
});

module.exports = mongoose.model("FlightFare", FlightFareSchema, "flight_fares");