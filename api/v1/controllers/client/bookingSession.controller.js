const sendResponseHelper = require("../../../../helpers/sendResponse.helper");
const BookingSession = require("../../models/bookingSession.model");
const SeatClass = require("../../models/seatClass.model");
const FlightSchedule = require("../../models/flightSchedule.model");
const FlightFare = require("../../models/flightFare.model");
const { addMinutes } = require("../../../../helpers/addMinutes.helper");
const { buildGuestId } = require("../../../../helpers/buildGuestId.helper");

// [POST] /api/v1/booking-sessions/create
module.exports.create = async (req, res) => {
  try {
    const {
      tripType = "ONE_WAY",
      segments = [],
      passengersCount,
      idempotencyKey,
    } = req.body || {};

    // 1) validate pax
    const pax = {
      adults: Number(passengersCount?.adults ?? 1),
      children: Number(passengersCount?.children ?? 0),
      infants: Number(passengersCount?.infants ?? 0),
    };
    if (!Number.isFinite(pax.adults) || pax.adults < 1) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid adults" });
    }
    if (!Number.isFinite(pax.children) || pax.children < 0) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid children" });
    }
    if (!Number.isFinite(pax.infants) || pax.infants < 0) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid infants" });
    }

    // 2) validate segments basic
    if (!Array.isArray(segments) || segments.length < 1 || segments.length > 2) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "segments must be 1 or 2 items" });
    }

    const normalizedTripType = tripType === "ROUND_TRIP" ? "ROUND_TRIP" : "ONE_WAY";

    // rule số lượng segment theo tripType
    if (normalizedTripType === "ONE_WAY" && segments.length !== 1) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "ONE_WAY must have 1 segment" });
    }
    if (normalizedTripType === "ROUND_TRIP" && segments.length !== 2) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "ROUND_TRIP must have 2 segments" });
    }

    // rule direction
    const dirs = segments.map(s => s?.direction);
    if (normalizedTripType === "ONE_WAY") {
      if (dirs[0] !== "OUTBOUND") {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "ONE_WAY direction must be OUTBOUND" });
      }
    } else {
      const hasOut = dirs.includes("OUTBOUND");
      const hasIn = dirs.includes("INBOUND");
      if (!hasOut || !hasIn) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "ROUND_TRIP must include OUTBOUND & INBOUND" });
      }
    }

    // 3) owner: account hoặc guest
    const accountId = req.user?._id || null;

    const guestIdFromCookie = req.cookies?.guest_id;
    const guestId = accountId ? null : (guestIdFromCookie || buildGuestId());

    // 4) idempotency: trả session cũ nếu còn active
    if (idempotencyKey) {
      const existing = await BookingSession.findOne({
        idempotencyKey,
        status: { $in: ["ACTIVE", "HOLDING", "PAYMENT_PENDING"] },
        ...(accountId ? { accountId } : { guestId }),
        expiresAt: { $gt: new Date() },
      }).lean();

      if (existing) {
        return sendResponseHelper.successResponse(res, {
          data: {
            publicId: existing.publicId,
            status: existing.status,
            expiresAt: existing.expiresAt,
          },
        });
      }
    }

    // 5) resolve từng segment -> flightSchedule + seatClass + fare + priceSnapshot
    const builtSegments = [];
    let grand = { currency: "VND", adult: 0, child: 0, infant: 0, total: 0 };

    for (const seg of segments) {
      const flightScheduleId = seg?.flightScheduleId;
      const seatClassCodeRaw = seg?.seatClassCode;

      if (!flightScheduleId || !seatClassCodeRaw) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 400,
          errorCode: "Each segment requires flightScheduleId & seatClassCode",
        });
      }

      const seatClassCode = String(seatClassCodeRaw).trim().toUpperCase();

      // seatClass
      const seatClassDoc = await SeatClass.findOne({
        classCode: seatClassCode,
        deleted: false,
        status: "active",
      }).lean();
      if (!seatClassDoc) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: `Invalid seatClassCode: ${seatClassCode}` });
      }

      // flightSchedule
      const fs = await FlightSchedule.findOne({
        _id: flightScheduleId,
        deleted: false,
        status: "scheduled",
      }).lean();
      if (!fs) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: `Invalid flightScheduleId: ${flightScheduleId}` });
      }

      // fare snapshot từ DB
      const fare = await FlightFare.findOne({
        flightScheduleId: fs._id,
        seatClassId: seatClassDoc._id,
        deleted: false,
      }).select("basePrice tax serviceFee").lean();

      if (!fare) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Fare not found" });
      }

      const adultUnit = Number(fare.basePrice || 0) + Number(fare.tax || 0) + Number(fare.serviceFee || 0);
      // Sau này thêm giá cho từng thành viên sau
      const childUnit = Math.round(adultUnit * 0.75);
      const infantUnit = Math.round(adultUnit * 0.1);

      const total = pax.adults * adultUnit + pax.children * childUnit + pax.infants * infantUnit;

      // accumulate grand total (cộng theo chặng)
      grand.adult += adultUnit;
      grand.child += childUnit;
      grand.infant += infantUnit;
      grand.total += total;

      builtSegments.push({
        direction: seg.direction,                 // OUTBOUND / INBOUND
        flightScheduleId: fs._id,
        seatClassCode,                            // lưu snapshot code
        seatClassId: seatClassDoc._id,            // lưu id
        selectedSeatIds: [],
        priceSnapshot: {
          currency: "VND",
          adult: adultUnit,
          child: childUnit,
          infant: infantUnit,
          total,
        },
      });
    }

    // 6) create session
    const now = new Date();
    const ttlMin = Number(process.env.BOOKING_SESSION_TTL_MINUTES || 15);
    const expiresAt = addMinutes(now, ttlMin);

    const session = new BookingSession({
      ownerType: accountId ? "ACCOUNT" : "GUEST",
      accountId: accountId || undefined,
      guestId: guestId || undefined,

      tripType: normalizedTripType,
      segments: builtSegments,
      passengersCount: pax,

      grandTotalSnapshot: {
        currency: grand.currency,
        adult: grand.adult,
        child: grand.child,
        infant: grand.infant,
        total: grand.total,
      },

      status: "ACTIVE",
      expiresAt,
      lastActivityAt: now,
      idempotencyKey: idempotencyKey || undefined,
      createdIp: req.ip,
      userAgent: req.headers["user-agent"],
    });

    const rawSecret = session.generateAndSetSecret();
    await session.save();

    // cookies
    if (!accountId && !guestIdFromCookie) {
      res.cookie("guest_id", guestId, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }

    res.cookie("bs_token", rawSecret, {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      maxAge: ttlMin * 60 * 1000,
    });

    return sendResponseHelper.successResponse(res, {
      data: { publicId: session.publicId, status: session.status, expiresAt: session.expiresAt },
    });
  } catch (error) {
    return sendResponseHelper.errorResponse(res, { errorCode: error.message });
  }
};