const mongoose = require("mongoose");

const SeatClassSchema = new mongoose.Schema(
  {
    className: { type: String, trim: true, required: true, unique: true, enum: ["Economy", "Premium Economy", "Business Class", "First Class"] },
    classCode: { type: String, trim: true, required: true, unique: true, uppercase: true, match: /^[A-Z]+$/, minlength: 1, maxlength: 2 },
    description: { type: String, trim: true, },
    deleted: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SeatClass", SeatClassSchema, "seat_classes");
