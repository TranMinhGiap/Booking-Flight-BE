// models/seatType.model.js
const mongoose = require("mongoose");

const SeatTypeSchema = new mongoose.Schema(
  {
    /**
     * Code: STD / PREF / EXIT ...
     * -> unique theo từng seatClassId (Economy có thể khác Business)
     */
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      match: /^[A-Z0-9_]+$/,
    },

    label: { type: String, required: true, trim: true }, // "Ghế thường"
    color: { type: String, default: "#3b82f6", trim: true, match: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/i, uppercase: true }, // hex color

    // base price theo loại ghế (chưa cộng priceAdjustment)
    basePrice: { type: Number, default: 0, min: 0 },

    // thuộc seatClass nào (Economy/Business)
    seatClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SeatClass",
      required: true,
      index: true,
    },

    // optional flags
    isExitRowType: { type: Boolean, default: false },
    isPreferredType: { type: Boolean, default: false },

    deleted: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

// unique code within a seatClassId (ignore deleted)
SeatTypeSchema.index(
  { seatClassId: 1, code: 1 },
  {
    unique: true,
    name: "idx_unique_seat_type_code_per_class",
    partialFilterExpression: { deleted: false },
  }
);

module.exports = mongoose.model("SeatType", SeatTypeSchema, "seat_types");