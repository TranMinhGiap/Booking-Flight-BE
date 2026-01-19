const mongoose = require("mongoose");

const FlightScheduleSchema = new mongoose.Schema(
  {
    flightId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Flight",
      required: true,
      index: true,
    },
    airplaneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Airplane",
      required: true,
      index: true,
    },
    departureTime: {
      type: Date,
      required: true,
      index: true,
    },
    arrivalTime: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["draft", "scheduled", "delayed", "cancelled", "completed"],
      default: "draft",
      index: true,
    },
    deleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Validate arrival > departure
FlightScheduleSchema.pre("validate", function () {
  if (this.departureTime && this.arrivalTime && this.arrivalTime <= this.departureTime) {
    throw new Error("arrivalTime must be greater than departureTime");
  }
});

// Virtual duration (phút và giờ, tiện cho API/FE)
FlightScheduleSchema.virtual("durationMinutes").get(function () {
  if (!this.departureTime || !this.arrivalTime) return null;
  return Math.round((this.arrivalTime - this.departureTime) / (1000 * 60));
});

FlightScheduleSchema.virtual("durationHours").get(function () {
  const minutes = this.durationMinutes;
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
});

// Index search & conflict
FlightScheduleSchema.index({ flightId: 1, departureTime: 1 }, { name: "idx_flight_schedule_search" });
FlightScheduleSchema.index({ airplaneId: 1, departureTime: 1, deleted: 1 });

// Index active schedules
FlightScheduleSchema.index({ deleted: 1, status: 1 });

module.exports = mongoose.model("FlightSchedule", FlightScheduleSchema, "flight_schedules");