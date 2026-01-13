const mongoose = require("mongoose");

const AirportSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    iataCode: { type: String, required: true, unique: true, uppercase: true, trim: true, minlength: 3, maxlength: 3 },
    city: { type: String },
    country: { type: String, trim: true },
    timezone: { type: String, trim: true },
    deleted: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Airport", AirportSchema, "airports");
