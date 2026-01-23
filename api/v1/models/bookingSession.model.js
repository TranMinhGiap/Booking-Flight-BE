// models/bookingSession.model.js
const mongoose = require("mongoose");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const { Schema } = mongoose;

/**
 * Helpers: hash secret (KHÔNG lưu raw secret trong DB)
 */
function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

/**
 * Price snapshot schema (reuse)
 */
const PriceSnapshotSchema = new Schema(
  {
    currency: { type: String, default: "VND" },
    adult: { type: Number, default: 0, min: 0 },
    child: { type: Number, default: 0, min: 0 },
    infant: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/**
 * Segment schema: OUTBOUND / INBOUND (sau này multi-city thì direction có thể bỏ)
 */
const SegmentSchema = new Schema(
  {
    direction: {
      type: String,
      enum: ["OUTBOUND", "INBOUND"],
      required: true,
    },

    flightScheduleId: {
      type: Schema.Types.ObjectId,
      ref: "FlightSchedule",
      required: true,
      index: true,
    },

    seatClassCode: { type: String, required: true },

    seatClassId: {
      type: Schema.Types.ObjectId,
      ref: "SeatClass",
      required: true,
    },

    /**
     * Ghế chọn riêng từng chặng.
     * Không dùng unique:true ở đây (không enforce đúng trên array).
     * Enforce seat hold phải làm ở collection flight_seats bằng update atomic.
     */
    selectedSeatIds: [{ type: Schema.Types.ObjectId, ref: "FlightSeat" }],

    priceSnapshot: { type: PriceSnapshotSchema, default: () => ({}) },
  },
  { _id: false }
);

const BookingSessionSchema = new Schema(
  {
    // ===== Public identifier (để hiển thị/điều hướng URL) =====
    publicId: {
      type: String,
      default: () => uuidv4(),
      required: true,
      unique: true,
      index: true,
      immutable: true,
    },

    // ===== Owner: guest hoặc account =====
    ownerType: {
      type: String,
      enum: ["GUEST", "ACCOUNT"],
      default: "GUEST",
      index: true,
    },

    accountId: { type: Schema.Types.ObjectId, ref: "Account", index: true },

    /**
     * guestId: lưu ID guest từ cookie (không cần bí mật)
     * dùng để “resume” session cho khách chưa login.
     */
    guestId: { type: String, index: true },

    /**
     * sessionSecretHash: hash của secret nằm trong cookie httpOnly (vd bs_token)
     * Mọi request update session/hold seat phải verify cookie secret -> hash khớp DB.
     */
    sessionSecretHash: { type: String, required: true, select: false, index: true },

    // ===== Trip core =====
    tripType: {
      type: String,
      enum: ["ONE_WAY", "ROUND_TRIP"],
      default: "ONE_WAY",
      index: true,
    },

    segments: {
      type: [SegmentSchema],
      validate: {
        validator(v) {
          return Array.isArray(v) && v.length >= 1 && v.length <= 2;
        },
        message: "segments must have 1 (one-way) or 2 (round-trip) items",
      },
      required: true,
      default: [],
    },

    passengersCount: {
      adults: { type: Number, default: 1, min: 1 },
      children: { type: Number, default: 0, min: 0 },
      infants: { type: Number, default: 0, min: 0 },
    },

    /**
     * passengers: bạn có thể thay bằng schema chi tiết (name/dob/passport...)
     * giữ Array để linh hoạt, nhưng nên validate ở layer service/controller.
     */
    passengers: { type: [Schema.Types.Mixed], default: [] },

    /**
     * Tổng tiền snapshot của cả itinerary (OUTBOUND + INBOUND)
     * cập nhật mỗi khi thay đổi segment.priceSnapshot hoặc pax count.
     */
    grandTotalSnapshot: { type: PriceSnapshotSchema, default: () => ({}) },

    // ===== Lifecycle =====
    status: {
      type: String,
      enum: [
        "ACTIVE",          // session sống, user đang thao tác
        "HOLDING",         // đã hold 1 phần/đủ ghế (tuỳ bạn set khi chọn ghế)
        "PAYMENT_PENDING", // redirect/đang chờ payment gateway
        "CONFIRMED",       // đã convert thành booking thật
        "CANCELLED",       // user huỷ
        "EXPIRED",         // hết hạn
      ],
      default: "ACTIVE",
      index: true,
    },

    /**
     * expiresAt: hạn session/hold (TTL xóa session).
     * Thực tế bạn sẽ set = now + 10/15 phút ngay khi tạo session,
     * và refresh (extend) khi có activity hoặc khi user đổi ghế.
     */
    expiresAt: { type: Date, required: true },

    lastActivityAt: { type: Date, default: Date.now, index: true },

    // optional: idempotency (ngăn double-click create session)
    idempotencyKey: { type: String, index: true },

    // optional: telemetry/debug/anti-abuse
    createdIp: { type: String },
    userAgent: { type: String },
  },
  { timestamps: true }
);

/**
 * TTL index: mongo sẽ tự xoá document khi expiresAt < now
 */
BookingSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Query indexes phổ biến
 */
BookingSessionSchema.index({ ownerType: 1, status: 1, expiresAt: 1 });
BookingSessionSchema.index({ accountId: 1, status: 1, expiresAt: 1 });
BookingSessionSchema.index({ guestId: 1, status: 1, expiresAt: 1 });
BookingSessionSchema.index({ "segments.flightScheduleId": 1, status: 1, expiresAt: 1 });

/**
 * Validate: nếu ownerType=ACCOUNT thì accountId phải có.
 * nếu ownerType=GUEST thì accountId phải null/undefined.
 * Validate: segments direction hợp lệ cho tripType.
 */
BookingSessionSchema.pre("validate", function () {
  // owner rules
  if (this.ownerType === "ACCOUNT") {
    if (!this.accountId) throw new Error("ACCOUNT session must have accountId");
  }
  if (this.ownerType === "GUEST") {
    // cho phép accountId không set
    if (this.accountId) throw new Error("GUEST session must not have accountId");
  }

  // segment rules
  const segs = this.segments || [];
  if (!segs.length) throw new Error("segments is required");

  if (this.tripType === "ONE_WAY") {
    if (segs.length !== 1) throw new Error("ONE_WAY must have exactly 1 segment");
  } else if (this.tripType === "ROUND_TRIP") {
    if (segs.length !== 2) throw new Error("ROUND_TRIP must have exactly 2 segments");
    const dirs = segs.map((s) => s.direction);
    const hasOut = dirs.includes("OUTBOUND");
    const hasIn = dirs.includes("INBOUND");
    if (!hasOut || !hasIn) throw new Error("ROUND_TRIP must include OUTBOUND and INBOUND segments");
  }

  // passengersCount sanity
  const pc = this.passengersCount || {};
  if ((pc.adults ?? 0) < 1) throw new Error("adults must be >= 1");
  if ((pc.children ?? 0) < 0) throw new Error("children must be >= 0");
  if ((pc.infants ?? 0) < 0) throw new Error("infants must be >= 0");

  // last activity
  if (!this.lastActivityAt) this.lastActivityAt = new Date();
});

/**
 * Instance methods: set/verify secret
 * - create session: generate secret raw, store hash in DB, trả raw secret để set cookie httpOnly
 */
BookingSessionSchema.methods.generateAndSetSecret = function () {
  const rawSecret = crypto.randomBytes(32).toString("hex"); // 64 chars
  this.sessionSecretHash = sha256(rawSecret);
  return rawSecret;
};

BookingSessionSchema.methods.verifySecret = function (rawSecret) {
  if (!rawSecret) return false;
  return this.sessionSecretHash === sha256(rawSecret);
};

/**
 * Utility: recompute grandTotalSnapshot từ segments + pax count (tuỳ rule của bạn)
 * Gợi ý: gọi ở service mỗi lần update giá/segment.
 */
BookingSessionSchema.methods.recomputeGrandTotal = function () {
  const segs = this.segments || [];
  const sum = { currency: "VND", adult: 0, child: 0, infant: 0, total: 0 };

  for (const s of segs) {
    const p = s.priceSnapshot || {};
    sum.currency = p.currency || sum.currency;
    sum.adult += Number(p.adult || 0);
    sum.child += Number(p.child || 0);
    sum.infant += Number(p.infant || 0);
    sum.total += Number(p.total || 0);
  }

  this.grandTotalSnapshot = sum;
};

module.exports = mongoose.model("BookingSession", BookingSessionSchema, "booking_sessions");