const mongoose = require("mongoose");

const AirlineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    iataCode: { type: String, required: true, unique: true, uppercase: true, trim: true, minlength: 1, maxlength: 3, match: /^[A-Z0-9]{1,3}$/ },
    logoUrl: { type: String, trim: true },
    deleted: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Airline", AirlineSchema, "airlines");
