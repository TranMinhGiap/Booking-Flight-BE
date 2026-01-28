// models/paymentMethod.model.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const PaymentMethodSchema = new Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, index: true, immutable: true }, 

    name: { type: String, required: true, trim: true },

    provider: { type: String, required: true, uppercase: true, trim: true },

    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 100, index: true },

    minAmount: { type: Number, default: 0, min: 0 },
    maxAmount: { type: Number, default: 0, min: 0 },

    publicConfig: { type: Schema.Types.Mixed, default: null },        
    privateConfig: { type: Schema.Types.Mixed, default: null, select: false }, 

    currencies: { type: [String], default: ["VND"] },

    deleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

PaymentMethodSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { deleted: false } }
);

PaymentMethodSchema.index({ enabled: 1, deleted: 1, sortOrder: 1 });

module.exports = mongoose.model("PaymentMethod", PaymentMethodSchema, "payment_methods");