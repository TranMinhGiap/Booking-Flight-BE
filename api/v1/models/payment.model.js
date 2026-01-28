const mongoose = require("mongoose");
const { Schema } = mongoose;
const { v4: uuidv4 } = require("uuid");

const MoneySchema = new Schema(
  {
    currency: { type: String, default: "VND" },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const PaymentSchema = new Schema(
  {
    bookingSessionId: { type: Schema.Types.ObjectId, ref: "BookingSession", required: true, index: true },

    // copy từ bookingSession.publicId
    bookingSessionPublicId: { type: String, required: true, index: true },

    // payment public id
    paymentPublicId: {
      type: String,
      required: true,
      index: true,
      unique: true,
      immutable: true,
      default: () => uuidv4(),
    },

    methodCode: { type: String, required: true, uppercase: true, trim: true, index: true },
    provider: { type: String, required: true, uppercase: true, trim: true, index: true },

    attemptNo: { type: Number, required: true, min: 1, index: true },

    amount: { type: MoneySchema, required: true },

    status: {
      type: String,
      enum: ["INIT", "PENDING", "SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"],
      default: "INIT",
      index: true,
    },

    clientIdempotencyKey: { type: String, trim: true, default: null, index: true },

    providerPaymentId: { type: String, trim: true, default: null, index: true },
    paymentUrl: { type: String, trim: true, default: null },

    requestPayload: { type: Schema.Types.Mixed, default: null },
    returnPayload: { type: Schema.Types.Mixed, default: null },
    ipnPayload: { type: Schema.Types.Mixed, default: null },

    expiresAt: { type: Date, default: null, index: true },

    createdIp: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true }
);

// idempotency scoped by methodCode (đổi method vẫn tạo attempt mới)
PaymentSchema.index(
  { bookingSessionId: 1, methodCode: 1, clientIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      clientIdempotencyKey: { $exists: true, $type: "string", $ne: "" },
    },
  }
);

// attemptNo global theo session
PaymentSchema.index({ bookingSessionId: 1, attemptNo: 1 }, { unique: true });

// optional unique providerPaymentId (đúng cái bạn muốn)
PaymentSchema.index(
  { provider: 1, providerPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerPaymentId: { $exists: true, $type: "string", $ne: "" },
    },
  }
);

// list nhanh theo session
PaymentSchema.index({ bookingSessionId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", PaymentSchema, "payments");