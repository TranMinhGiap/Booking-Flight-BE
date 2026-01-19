const mongoose = require("mongoose");

const FlightSeatSchema = new mongoose.Schema(
  {
    flightScheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "FlightSchedule", required: true, index: true },
    seatLayoutId: { type: mongoose.Schema.Types.ObjectId, ref: "SeatLayout", required: true, index: true },

    priceAdjustment: { type: Number, default: 0 },

    // available: chưa giữ/chưa đặt
    // held: đang giữ tạm (hold)
    // booked: đã đặt
    status: { type: String, enum: ["available", "held", "booked"], default: "available", index: true },

    // hold
    blockedBySessionId: {
      type: mongoose.Schema.Types.ObjectId,  // <-- Đổi thành ref BookingSession
      ref: "BookingSession",
      index: true,
    },
    blockedAt: { type: Date },
    blockedUntil: { type: Date, index: true },

    // booked
    bookedAt: { type: Date },
    bookedByBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },  // optional nếu cần

    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// enforce logic consistency
// Nếu status = "held" thì bắt buộc có blockedBySessionId và blockedUntil, Nếu status = "booked" thì nên có bookedAt (và có thể bookedByBookingId)
FlightSeatSchema.pre("validate", function () {
  // 1) HELD: bắt buộc có blockedBySessionId + blockedUntil
  if (this.status === "held") {
    if (!this.blockedBySessionId || !this.blockedUntil) {
      throw new Error("Held seat must have blockedBySessionId and blockedUntil");
    }
    // nếu đang held mà blockedAt chưa có thì set luôn
    if (!this.blockedAt) this.blockedAt = new Date();
  } else {
    // 2) NOT HELD: xoá metadata hold cho sạch
    this.blockedBySessionId = undefined;
    this.blockedAt = undefined;
    this.blockedUntil = undefined;
  }

  // 3) BOOKED: set bookedAt nếu thiếu, còn không booked thì xoá metadata booked
  if (this.status === "booked") {
    if (!this.bookedAt) this.bookedAt = new Date();
  } else {
    this.bookedAt = undefined;
    this.bookedByBookingId = undefined;
  }

  // 4) optional sanity: nếu booked thì không thể còn blocked*
  if (this.status === "booked") {
    this.blockedBySessionId = undefined;
    this.blockedAt = undefined;
    this.blockedUntil = undefined;
  }
});

// Unique seat per flight
FlightSeatSchema.index(
  { flightScheduleId: 1, seatLayoutId: 1 },
  { unique: true, name: "idx_unique_seat_per_flight" }  
);

// Query seats by status + active
FlightSeatSchema.index({ flightScheduleId: 1, status: 1, deleted: 1 }, { name: "idx_available_seats" });

module.exports = mongoose.model("FlightSeat", FlightSeatSchema, "flight_seats");

