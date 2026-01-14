const mongoose = require("mongoose");

const SeatLayoutSchema = new mongoose.Schema(
  {
    airplaneId: { type: mongoose.Schema.Types.ObjectId, ref: "Airplane", required: true, index: true },
    seatClassId: { type: mongoose.Schema.Types.ObjectId, ref: "SeatClass", required: true, index: true },
    seatRow: { type: Number, required: true, min: 1 },
    seatColumn: { type: String, required: true, uppercase: true, match: /^[A-Z]+$/, trim: true },
    isWindow: { type: Boolean, default: false },
    isAisle: { type: Boolean, default: false },
    isExitRow: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
   }
);

SeatLayoutSchema.index(
  { airplaneId: 1, seatRow: 1, seatColumn: 1 },
  { unique: true, partialFilterExpression: { deleted: false }, name: "idx_seat_position" }
);

SeatLayoutSchema.virtual("seatNumber").get(function () {
  return `${this.seatRow}${this.seatColumn}`;
});

module.exports = mongoose.model("SeatLayout", SeatLayoutSchema, "seat_layouts");
