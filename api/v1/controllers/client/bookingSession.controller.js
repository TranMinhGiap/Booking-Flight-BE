const sendResponseHelper = require("../../../../helpers/sendResponse.helper");
const BookingSession = require("../../models/bookingSession.model");
const SeatClass = require("../../models/seatClass.model");
const FlightSchedule = require("../../models/flightSchedule.model");
const FlightFare = require("../../models/flightFare.model");
const { addMinutes } = require("../../../../helpers/addMinutes.helper");
const { buildGuestId } = require("../../../../helpers/buildGuestId.helper");
const { sha256 } = require('../../../../helpers/sha256.helper');
const mongoose = require("mongoose");
const FlightSeat = require("../../models/flightSeat.model");
const SeatLayout = require("../../models/seatLayout.model");
const SeatType = require("../../models/seatType.model");

// [GET] /api/v1/booking-sessions/:publicId
module.exports.index = async (req, res) => {
  try {
    const { publicId } = req.params;

    if (!publicId || typeof publicId !== "string") {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "publicId is required",
      });
    }

    const now = new Date();

    // ===== 1) Load minimal session for auth verify =====
    const sessionAuth = await BookingSession.findOne({ publicId })
      .select("publicId ownerType accountId guestId status expiresAt")
      .select("+sessionSecretHash")
      .lean();

    if (!sessionAuth) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 404,
        errorCode: "BookingSession not found",
      });
    }

    if (sessionAuth.expiresAt && new Date(sessionAuth.expiresAt) <= now) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 410,
        errorCode: "BookingSession expired",
      });
    }

    if (["EXPIRED", "CANCELLED"].includes(sessionAuth.status)) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 410,
        errorCode: `BookingSession ${String(sessionAuth.status).toLowerCase()}`,
      });
    }

    // ===== 2) Verify owner =====
    if (sessionAuth.ownerType === "ACCOUNT") {
      const userId = req.user?._id;
      if (!userId) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 401,
          errorCode: "Unauthorized",
        });
      }
      if (String(userId) !== String(sessionAuth.accountId)) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 403,
          errorCode: "Forbidden",
        });
      }
    } else {
      // GUEST
      const guestId = req.cookies?.guest_id;
      const bsToken = req.cookies?.bs_token;

      if (!guestId || !bsToken) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 401,
          errorCode: "Unauthorized (missing guest cookies)",
        });
      }

      if (String(sessionAuth.guestId || "") !== String(guestId)) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 403,
          errorCode: "Forbidden (guestId mismatch)",
        });
      }

      const tokenHash = sha256(bsToken);
      if (tokenHash !== sessionAuth.sessionSecretHash) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 403,
          errorCode: "Forbidden (invalid session secret)",
        });
      }
    }

    // ===== 3) Fetch full session with joins (aggregate) =====
    const pipeline = [
      { $match: { publicId } },

      // unwind segments + include index (preserve order)
      { $unwind: { path: "$segments", includeArrayIndex: "_idx" } },

      // join FlightSchedule
      {
        $lookup: {
          from: "flight_schedules",
          localField: "segments.flightScheduleId",
          foreignField: "_id",
          as: "fs",
        },
      },
      { $unwind: "$fs" },
      { $match: { "fs.deleted": false } },

      // join Flight
      {
        $lookup: {
          from: "flights",
          localField: "fs.flightId",
          foreignField: "_id",
          as: "flight",
        },
      },
      { $unwind: "$flight" },
      { $match: { "flight.deleted": false, "flight.status": "active" } },
      {
        $addFields: {
          _durationMs: { $subtract: ["$fs.arrivalTime", "$fs.departureTime"] },
        },
      },
      {
        $addFields: {
          _durationMinutesSafe: {
            $cond: {
              if: { $gte: ["$_durationMs", 0] },
              then: { $round: [{ $divide: ["$_durationMs", 60000] }] },
              else: "$flight.durationMinutes",
            },
          },
        },
      },

      // join Airline
      {
        $lookup: {
          from: "airlines",
          localField: "flight.airlineId",
          foreignField: "_id",
          as: "airline",
        },
      },
      { $unwind: "$airline" },
      { $match: { "airline.deleted": false, "airline.status": "active" } },

      // join Airports (from)
      {
        $lookup: {
          from: "airports",
          localField: "flight.departureAirportId",
          foreignField: "_id",
          as: "fromAirport",
        },
      },
      { $unwind: "$fromAirport" },
      { $match: { "fromAirport.deleted": false, "fromAirport.status": "active" } },

      // join Airports (to)
      {
        $lookup: {
          from: "airports",
          localField: "flight.arrivalAirportId",
          foreignField: "_id",
          as: "toAirport",
        },
      },
      { $unwind: "$toAirport" },
      { $match: { "toAirport.deleted": false, "toAirport.status": "active" } },

      // join SeatClass
      {
        $lookup: {
          from: "seat_classes",
          localField: "segments.seatClassId",
          foreignField: "_id",
          as: "seatClass",
        },
      },
      { $unwind: "$seatClass" },
      { $match: { "seatClass.deleted": false, "seatClass.status": "active" } },

      // build segment payload (UPDATED for new model)
      {
        $addFields: {
          _segmentOut: {
            _idx: "$_idx",
            direction: "$segments.direction",

            seatClass: {
              id: "$seatClass._id",
              code: "$segments.seatClassCode",
              name: "$seatClass.className",
            },

            seatAssignments: "$segments.seatAssignments",
            seatTotalSnapshot: "$segments.seatTotalSnapshot",

            // base fare snapshot (without seat fee)
            priceSnapshot: "$segments.priceSnapshot",

            flightSchedule: {
              id: "$fs._id",
              departureAt: "$fs.departureTime",
              arrivalAt: "$fs.arrivalTime",
              durationMinutes: "$_durationMinutesSafe",
              status: "$fs.status",
              airplaneId: "$fs.airplaneId",
            },

            flight: {
              id: "$flight._id",
              flightNumber: "$flight.flightNumber",
              durationMinutes: "$flight.durationMinutes",

              airline: {
                id: "$airline._id",
                code: "$airline.iataCode",
                name: "$airline.name",
                logoUrl: "$airline.logoUrl",
              },

              from: {
                id: "$fromAirport._id",
                code: "$fromAirport.iataCode",
                name: "$fromAirport.name",
                city: "$fromAirport.city",
                timeZone: "$fromAirport.timezone",
              },

              to: {
                id: "$toAirport._id",
                code: "$toAirport.iataCode",
                name: "$toAirport.name",
                city: "$toAirport.city",
                timeZone: "$toAirport.timezone",
              },
            },
          },
        },
      },

      // regroup back to 1 doc
      {
        $group: {
          _id: "$_id",
          publicId: { $first: "$publicId" },
          ownerType: { $first: "$ownerType" },
          accountId: { $first: "$accountId" },
          guestId: { $first: "$guestId" },
          tripType: { $first: "$tripType" },
          passengersCount: { $first: "$passengersCount" },
          passengers: { $first: "$passengers" },
          contactInfo: { $first: "$contactInfo" },
          grandTotalSnapshot: { $first: "$grandTotalSnapshot" },
          status: { $first: "$status" },
          expiresAt: { $first: "$expiresAt" },
          lastActivityAt: { $first: "$lastActivityAt" },
          createdAt: { $first: "$createdAt" },
          updatedAt: { $first: "$updatedAt" },
          segments: { $push: "$_segmentOut" },
        },
      },

      // final payload
      {
        $project: {
          _id: 0,
          publicId: 1,
          ownerType: 1,
          accountId: 1,
          guestId: 1,
          tripType: 1,
          passengersCount: 1,
          passengers: 1,
          contactInfo: 1,
          grandTotalSnapshot: 1,
          status: 1,
          expiresAt: 1,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1,
          segments: 1,
        },
      },
    ];

    const arr = await BookingSession.aggregate(pipeline);
    const out = arr?.[0];

    if (!out) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 404,
        errorCode: "BookingSession not found (invalid itinerary data)",
      });
    }

    // sort segments and drop _idx
    out.segments = (out.segments || [])
      .sort((a, b) => Number(a._idx || 0) - Number(b._idx || 0))
      .map(({ _idx, ...rest }) => rest);

    // ===== 4) remaining seconds for FE countdown =====
    const remainingMs = out.expiresAt
      ? new Date(out.expiresAt).getTime() - now.getTime()
      : 0;

    return sendResponseHelper.successResponse(res, {
      data: {
        ...out,
        meta: {
          serverTime: now.toISOString(),
          remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
        },
      },
    });
  } catch (error) {
    return sendResponseHelper.errorResponse(res, { errorCode: error.message });
  }
};
// [POST] /api/v1/booking-sessions/create
const ALLOWED_SCHEDULE_STATUS = new Set(["scheduled", "delayed"]); // tuỳ nghiệp vụ
const MIN_TURNAROUND_MINUTES = Number(process.env.MIN_TURNAROUND_MINUTES || 0);

function addMinutes(date, minutes) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + Number(minutes || 0));
  return d;
}

function buildGuestId() {
  // tuỳ : uuid, nanoid...
  return `guest_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeTripType(tripType) {
  return tripType === "ROUND_TRIP" ? "ROUND_TRIP" : "ONE_WAY";
}

function normalizeSeatClassCode(code) {
  return String(code || "").trim().toUpperCase();
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id));
}

function toIdStr(x) {
  return x ? String(x) : "";
}

function assertPax(pax) {
  const adults = Number(pax?.adults ?? 1);
  const children = Number(pax?.children ?? 0);
  const infants = Number(pax?.infants ?? 0);

  if (!Number.isFinite(adults) || adults < 1) return { ok: false, error: "Invalid adults" };
  if (!Number.isFinite(children) || children < 0) return { ok: false, error: "Invalid children" };
  if (!Number.isFinite(infants) || infants < 0) return { ok: false, error: "Invalid infants" };

  // nghiệp vụ thường gặp: infants <= adults
  if (infants > adults) return { ok: false, error: "Infants cannot exceed adults" };

  return { ok: true, pax: { adults, children, infants } };
}

function normalizeSegments(segments, tripType) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > 2) {
    return { ok: false, error: "segments must be 1 or 2 items" };
  }

  const t = normalizeTripType(tripType);

  if (t === "ONE_WAY" && segments.length !== 1) {
    return { ok: false, error: "ONE_WAY must have 1 segment" };
  }
  if (t === "ROUND_TRIP" && segments.length !== 2) {
    return { ok: false, error: "ROUND_TRIP must have 2 segments" };
  }

  // map theo direction để không phụ thuộc order FE gửi lên
  const map = new Map();
  for (const seg of segments) {
    const dir = seg?.direction;
    if (dir !== "OUTBOUND" && dir !== "INBOUND") {
      return { ok: false, error: "direction must be OUTBOUND or INBOUND" };
    }
    if (map.has(dir)) {
      return { ok: false, error: `Duplicate direction: ${dir}` };
    }
    map.set(dir, seg);
  }

  if (t === "ONE_WAY") {
    if (!map.has("OUTBOUND")) return { ok: false, error: "ONE_WAY direction must be OUTBOUND" };
  } else {
    if (!map.has("OUTBOUND") || !map.has("INBOUND")) {
      return { ok: false, error: "ROUND_TRIP must include OUTBOUND & INBOUND" };
    }
  }

  const out = map.get("OUTBOUND") || null;
  const inn = map.get("INBOUND") || null;

  // kiểm tra field bắt buộc
  const reqFields = (seg) => seg?.flightScheduleId && seg?.seatClassCode;
  if (out && !reqFields(out)) return { ok: false, error: "OUTBOUND requires flightScheduleId & seatClassCode" };
  if (inn && !reqFields(inn)) return { ok: false, error: "INBOUND requires flightScheduleId & seatClassCode" };

  // tránh user gửi cùng 1 schedule cho cả 2 chặng
  if (out && inn && toIdStr(out.flightScheduleId) === toIdStr(inn.flightScheduleId)) {
    return { ok: false, error: "OUTBOUND and INBOUND cannot be the same flightScheduleId" };
  }

  return { ok: true, tripType: t, out, inn };
}

async function loadSeatClass(seatClassCode) {
  const code = normalizeSeatClassCode(seatClassCode);
  if (!code) return null;

  const seatClassDoc = await SeatClass.findOne({
    classCode: code,
    deleted: false,
    status: "active",
  }).lean();

  if (!seatClassDoc) return null;
  return seatClassDoc;
}

/**
 * Load flightSchedule + populate flightId để có departureAirportId/arrivalAirportId
 */
async function loadScheduleWithFlight(flightScheduleId) {
  if (!isValidObjectId(flightScheduleId)) return null;

  const fs = await FlightSchedule.findOne({
    _id: flightScheduleId,
    deleted: false,
  })
    .populate({
      path: "flightId",
      select: "departureAirportId arrivalAirportId airlineId flightNumber status deleted durationMinutes",
    })
    .lean();

  if (!fs) return null;
  return fs;
}

async function loadFareSnapshot(flightScheduleId, seatClassId) {
  const fare = await FlightFare.findOne({
    flightScheduleId,
    seatClassId,
    deleted: false,
  })
    .select("basePrice tax serviceFee currency")
    .lean();

  if (!fare) return null;
  return fare;
}

function ensureScheduleBookable(fs) {
  if (!fs) return { ok: false, error: "Invalid flightScheduleId" };

  if (fs.deleted) return { ok: false, error: "FlightSchedule deleted" };

  if (!ALLOWED_SCHEDULE_STATUS.has(fs.status)) {
    return { ok: false, error: `FlightSchedule status not bookable: ${fs.status}` };
  }

  // nghiệp vụ: không cho đặt nếu đã bay
  const now = Date.now();
  const dep = fs.departureTime ? new Date(fs.departureTime).getTime() : null;
  if (!dep || !Number.isFinite(dep)) return { ok: false, error: "Invalid departureTime" };
  if (dep <= now) return { ok: false, error: "FlightSchedule already departed" };

  // flight must exist & active
  const fl = fs.flightId;
  if (!fl) return { ok: false, error: "Flight not found for schedule" };
  if (fl.deleted) return { ok: false, error: "Flight deleted" };
  if (fl.status && fl.status !== "active") return { ok: false, error: "Flight inactive" };

  return { ok: true };
}

function validateRoundTripBusiness(outFs, inFs) {
  // bắt buộc inbound đảo chiều outbound
  const outFlight = outFs?.flightId;
  const inFlight = inFs?.flightId;

  const outDep = toIdStr(outFlight?.departureAirportId);
  const outArr = toIdStr(outFlight?.arrivalAirportId);

  const inDep = toIdStr(inFlight?.departureAirportId);
  const inArr = toIdStr(inFlight?.arrivalAirportId);

  if (!outDep || !outArr || !inDep || !inArr) {
    return { ok: false, error: "Missing flight route info" };
  }

  // inbound phải là reverse route của outbound
  if (!(inDep === outArr && inArr === outDep)) {
    return {
      ok: false,
      error: "INBOUND route must be reverse of OUTBOUND",
      detail: {
        outbound: { from: outDep, to: outArr },
        inbound: { from: inDep, to: inArr },
      },
    };
  }

  // inbound phải bay sau outbound đến + turnaround
  const outArrTime = new Date(outFs.arrivalTime).getTime();
  const inDepTime = new Date(inFs.departureTime).getTime();

  const minInDep = outArrTime + MIN_TURNAROUND_MINUTES * 60 * 1000;
  if (inDepTime < minInDep) {
    return {
      ok: false,
      error: `INBOUND departure must be after OUTBOUND arrival (+${MIN_TURNAROUND_MINUTES}m)`,
    };
  }

  return { ok: true };
}

// [POST] /api/v1/booking-sessions/create
module.exports.create = async (req, res) => {
  try {
    const { tripType = "ONE_WAY", segments = [], passengersCount, idempotencyKey } = req.body || {};

    // 1) pax
    const paxResult = assertPax(passengersCount);
    if (!paxResult.ok) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: paxResult.error });
    }
    const pax = paxResult.pax;

    // 2) segments normalize (không phụ thuộc order FE)
    const segResult = normalizeSegments(segments, tripType);
    if (!segResult.ok) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: segResult.error });
    }
    const normalizedTripType = segResult.tripType;
    const outSeg = segResult.out;
    const inSeg = segResult.in;

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

    // 5) Resolve OUTBOUND
    const outSeatClass = await loadSeatClass(outSeg.seatClassCode);
    if (!outSeatClass) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: `Invalid seatClassCode: ${normalizeSeatClassCode(outSeg.seatClassCode)}`,
      });
    }

    const outFs = await loadScheduleWithFlight(outSeg.flightScheduleId);
    if (!outFs) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid OUTBOUND flightScheduleId" });
    }

    const outBookable = ensureScheduleBookable(outFs);
    if (!outBookable.ok) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: outBookable.error });
    }

    const outFare = await loadFareSnapshot(outFs._id, outSeatClass._id);
    if (!outFare) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "OUTBOUND fare not found" });
    }

    // 6) Resolve INBOUND (nếu round-trip)
    let inSeatClass = null;
    let inFs = null;
    let inFare = null;

    if (normalizedTripType === "ROUND_TRIP") {
      inSeatClass = await loadSeatClass(inSeg.seatClassCode);
      if (!inSeatClass) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 400,
          errorCode: `Invalid seatClassCode: ${normalizeSeatClassCode(inSeg.seatClassCode)}`,
        });
      }

      inFs = await loadScheduleWithFlight(inSeg.flightScheduleId);
      if (!inFs) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid INBOUND flightScheduleId" });
      }

      const inBookable = ensureScheduleBookable(inFs);
      if (!inBookable.ok) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: inBookable.error });
      }

      // ✅ Nghiệp vụ quan trọng: INBOUND đảo chiều OUTBOUND + validate thời gian
      const rt = validateRoundTripBusiness(outFs, inFs);
      if (!rt.ok) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: rt.error, detail: rt.detail });
      }

      inFare = await loadFareSnapshot(inFs._id, inSeatClass._id);
      if (!inFare) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "INBOUND fare not found" });
      }
    }

    // 7) Build segments + snapshot giá
    const builtSegments = [];
    let grand = { currency: "VND", adult: 0, child: 0, infant: 0, total: 0 };

    const buildSegment = ({ direction, fs, seatClassDoc, fare }) => {
      const basePrice = Number(fare.basePrice || 0);
      const tax = Number(fare.tax || 0);
      const serviceFee = Number(fare.serviceFee || 0);

      const adultUnit = basePrice + tax + serviceFee;

      // rule giá child/infant tuỳ nghiệp vụ (giữ như  đang làm)
      const childUnit = Math.round(adultUnit * 0.75);
      const infantUnit = Math.round(adultUnit * 0.1);

      const total = pax.adults * adultUnit + pax.children * childUnit + pax.infants * infantUnit;

      grand.adult += pax.adults * adultUnit;
      grand.child += pax.children * childUnit;
      grand.infant += pax.infants * infantUnit;
      grand.total += total;

      const flight = fs.flightId;

      return {
        direction,                     // OUTBOUND / INBOUND
        flightScheduleId: fs._id,
        seatClassCode: seatClassDoc.classCode,
        seatClassId: seatClassDoc._id,

        // seat selection
        seatAssignments: [],
        seatTotalSnapshot: { currency: fare.currency || "VND", total: 0 },

        // snapshot lịch bay (để sau này schedule/flight đổi vẫn giữ “audit”)
        scheduleSnapshot: {
          status: fs.status,
          departureTime: fs.departureTime,
          arrivalTime: fs.arrivalTime,
          flightId: flight?._id,
          flightNumber: flight?.flightNumber,
          airlineId: flight?.airlineId,
          fromAirportId: flight?.departureAirportId,
          toAirportId: flight?.arrivalAirportId,
          durationMinutes: flight?.durationMinutes,
        },

        // fare snapshot (base fare - chưa gồm seat fee)
        fareSnapshot: {
          currency: fare.currency || "VND",
          basePrice,
          tax,
          serviceFee,
        },

        priceSnapshot: {
          currency: fare.currency || "VND",
          adult: adultUnit,
          child: childUnit,
          infant: infantUnit,
          total,
        },
      };
    };

    // OUTBOUND
    builtSegments.push(
      buildSegment({
        direction: "OUTBOUND",
        fs: outFs,
        seatClassDoc: outSeatClass,
        fare: outFare,
      })
    );

    // INBOUND
    if (normalizedTripType === "ROUND_TRIP") {
      builtSegments.push(
        buildSegment({
          direction: "INBOUND",
          fs: inFs,
          seatClassDoc: inSeatClass,
          fare: inFare,
        })
      );
    }

    // 8) create session
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
      contactInfo: {},

      // grand total: chỉ base fare (chưa gồm seat fee) -> đúng nghiệp vụ “tính lại khi chọn ghế”
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

    const rawSecret = session.generateAndSetSecret?.() || null;
    await session.save();

    // 9) cookies
    if (!accountId && !guestIdFromCookie) {
      res.cookie("guest_id", guestId, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }

    if (rawSecret) {
      res.cookie("bs_token", rawSecret, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: ttlMin * 60 * 1000,
      });
    }

    return sendResponseHelper.successResponse(res, {
      data: {
        publicId: session.publicId,
        status: session.status,
        expiresAt: session.expiresAt,
        tripType: session.tripType,
        grandTotalSnapshot: session.grandTotalSnapshot,
      },
    });
  } catch (error) {
    return sendResponseHelper.errorResponse(res, { errorCode: error.message });
  }
};
// [PATCH] /api/v1/booking-sessions/:publicId/seat-assignments
module.exports.patchSeatAssignments = async (req, res) => {
  function assertValidDirection(direction) {
    return direction === "OUTBOUND" || direction === "INBOUND";
  }
  function calcSeatPriceVND({ seatTypeBasePrice = 0, priceAdjustment = 0 }) {
    return Number(seatTypeBasePrice || 0) + Number(priceAdjustment || 0);
  }
  const mongoSession = await mongoose.startSession();
  try {
    // body: { direction, paxIndex, seatId }
    const { publicId } = req.params;
    const { direction, paxIndex, seatId } = req.body || {};

    if (!publicId) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "publicId is required" });
    }
    if (!assertValidDirection(direction)) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid direction" });
    }
    const paxIdx = Number(paxIndex);
    if (!Number.isInteger(paxIdx) || paxIdx < 0) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid paxIndex" });
    }

    const now = new Date();
    const ttlMin = Number(process.env.BOOKING_SESSION_TTL_MINUTES || 15);

    let outSession = null;

    await mongoSession.withTransaction(async () => {
      // 1) Load session (must include sessionSecretHash)
      const bs = await BookingSession.findOne({ publicId })
        .select("+sessionSecretHash")
        .session(mongoSession);

      if (!bs) {
        throw Object.assign(new Error("BookingSession not found"), { _http: 404 });
      }

      if (bs.expiresAt && new Date(bs.expiresAt) <= now) {
        throw Object.assign(new Error("BookingSession expired"), { _http: 410 });
      }
      if (["EXPIRED", "CANCELLED"].includes(bs.status)) {
        throw Object.assign(new Error(`BookingSession ${String(bs.status).toLowerCase()}`), { _http: 410 });
      }

      // 2) Verify owner (giống GET /booking-sessions/:publicId)
      if (bs.ownerType === "ACCOUNT") {
        const userId = req.user?._id;
        if (!userId) throw Object.assign(new Error("Unauthorized"), { _http: 401 });
        if (String(userId) !== String(bs.accountId)) throw Object.assign(new Error("Forbidden"), { _http: 403 });
      } else {
        const guestId = req.cookies?.guest_id;
        const bsToken = req.cookies?.bs_token;

        if (!guestId || !bsToken) throw Object.assign(new Error("Unauthorized (missing guest cookies)"), { _http: 401 });
        if (String(bs.guestId || "") !== String(guestId)) throw Object.assign(new Error("Forbidden (guestId mismatch)"), { _http: 403 });

        const tokenHash = sha256(bsToken);
        if (tokenHash !== bs.sessionSecretHash) throw Object.assign(new Error("Forbidden (invalid session secret)"), { _http: 403 });
      }

      // 3) Validate paxIndex range (adult + child need seat)
      const pc = bs.passengersCount || {};
      const maxSeatPax = Number(pc.adults || 0) + Number(pc.children || 0);
      if (paxIdx >= maxSeatPax) {
        throw Object.assign(new Error("paxIndex out of range"), { _http: 400 });
      }

      // 4) Extend expiresAt on every activity (để user thao tác không bị timeout)
      const newExpiresAt = addMinutes(now, ttlMin);
      bs.expiresAt = newExpiresAt;
      bs.lastActivityAt = now;

      // Update all seats held by this session -> extend blockedUntil
      await FlightSeat.updateMany(
        { blockedBySessionId: bs._id, status: "held", deleted: false },
        { $set: { blockedUntil: newExpiresAt } },
        { session: mongoSession }
      );

      // 5) Locate segment
      const seg = (bs.segments || []).find((s) => s.direction === direction);
      if (!seg) {
        throw Object.assign(new Error("Segment not found for direction"), { _http: 400 });
      }

      // 6) Find current assignment of this pax
      const prevAssignIdx = (seg.seatAssignments || []).findIndex((a) => Number(a.paxIndex) === paxIdx);
      const prevAssign = prevAssignIdx >= 0 ? seg.seatAssignments[prevAssignIdx] : null;
      const prevSeatId = prevAssign?.seatId ? String(prevAssign.seatId) : null;

      // 7) If clear seatId => release previous seat and remove assignment
      if (!seatId) {
        if (prevSeatId) {
          await FlightSeat.updateOne(
            { _id: prevSeatId, blockedBySessionId: bs._id, status: "held", deleted: false },
            {
              $set: { status: "available" },
              $unset: { blockedBySessionId: 1, blockedAt: 1, blockedUntil: 1 },
            },
            { session: mongoSession }
          );
        }

        if (prevAssignIdx >= 0) {
          seg.seatAssignments.splice(prevAssignIdx, 1);
        }

        // recompute seatTotalSnapshot
        const total = (seg.seatAssignments || []).reduce(
          (sum, a) => sum + Number(a.seatPriceSnapshot?.total || 0),
          0
        );
        seg.seatTotalSnapshot = { currency: "VND", total };

        // status
        bs.status = "ACTIVE";

        await bs.save({ session: mongoSession });

        outSession = bs.toObject();
        return;
      }

      const nextSeatId = String(seatId);

      // 8) If changing seat => release old seat first
      if (prevSeatId && prevSeatId !== nextSeatId) {
        await FlightSeat.updateOne(
          { _id: prevSeatId, blockedBySessionId: bs._id, status: "held", deleted: false },
          {
            $set: { status: "available" },
            $unset: { blockedBySessionId: 1, blockedAt: 1, blockedUntil: 1 },
          },
          { session: mongoSession }
        );
      }

      // 9) Hold new seat (atomic)
      // only allow:
      // - available
      // - or held by this session
      const holdRes = await FlightSeat.updateOne(
        {
          _id: nextSeatId,
          flightScheduleId: seg.flightScheduleId,
          deleted: false,
          $or: [
            { status: "available" },
            { status: "held", blockedBySessionId: bs._id },
          ],
        },
        {
          $set: {
            status: "held",
            blockedBySessionId: bs._id,
            blockedAt: now,
            blockedUntil: bs.expiresAt,
          },
        },
        { session: mongoSession }
      );

      if (holdRes.matchedCount === 0) {
        throw Object.assign(new Error("Seat is not available"), { _http: 409 });
      }

      // 10) Build seat snapshot: seatNumber + price
      const fsSeat = await FlightSeat.findById(nextSeatId)
        .select("seatLayoutId priceAdjustment")
        .session(mongoSession);

      if (!fsSeat) throw Object.assign(new Error("Seat not found"), { _http: 404 });

      const layout = await SeatLayout.findById(fsSeat.seatLayoutId)
        .select("seatRow seatColumn seatTypeId seatTypeCode")
        .session(mongoSession);

      if (!layout) throw Object.assign(new Error("SeatLayout not found"), { _http: 500 });

      const seatNumber = `${layout.seatRow}${layout.seatColumn}`;

      let seatTypeBasePrice = 0;
      if (layout.seatTypeId) {
        const st = await SeatType.findById(layout.seatTypeId).select("basePrice").session(mongoSession);
        seatTypeBasePrice = Number(st?.basePrice || 0);
      }

      const price = calcSeatPriceVND({
        seatTypeBasePrice,
        priceAdjustment: fsSeat.priceAdjustment,
      });

      // 11) Upsert assignment
      const nextAssign = {
        paxIndex: paxIdx,
        seatId: nextSeatId,
        seatNumber,
        seatPriceSnapshot: { currency: "VND", total: price },
      };

      // enforce unique seatId inside this segment
      const seatTakenByOther = (seg.seatAssignments || []).find(
        (a) => String(a.seatId) === nextSeatId && Number(a.paxIndex) !== paxIdx
      );
      if (seatTakenByOther) {
        // rollback seat hold we just made (best effort)
        await FlightSeat.updateOne(
          { _id: nextSeatId, blockedBySessionId: bs._id, status: "held", deleted: false },
          {
            $set: { status: "available" },
            $unset: { blockedBySessionId: 1, blockedAt: 1, blockedUntil: 1 },
          },
          { session: mongoSession }
        );
        throw Object.assign(new Error("Seat already assigned to another passenger in this session"), { _http: 409 });
      }

      if (prevAssignIdx >= 0) {
        seg.seatAssignments[prevAssignIdx] = nextAssign;
      } else {
        seg.seatAssignments.push(nextAssign);
      }

      // 12) recompute seatTotalSnapshot
      const total = (seg.seatAssignments || []).reduce(
        (sum, a) => sum + Number(a.seatPriceSnapshot?.total || 0),
        0
      );
      seg.seatTotalSnapshot = { currency: "VND", total };

      bs.status = "HOLDING";

      await bs.save({ session: mongoSession });

      outSession = bs.toObject();
    });

    const remainingMs = outSession?.expiresAt
      ? new Date(outSession.expiresAt).getTime() - Date.now()
      : 0;

    // Gia hạn cookie bs_token để khớp TTL bookingSession (chỉ cho GUEST)
    if (outSession?.ownerType === "GUEST") {
      const bsToken = req.cookies?.bs_token;
      if (bsToken && outSession?.expiresAt) {
        res.cookie("bs_token", bsToken, {
          httpOnly: true,
          sameSite: "none",
          secure: true,
          maxAge: Math.max(0, remainingMs), // kéo dài đúng theo expiresAt mới
        });
      }
    }

    // trả tối thiểu những thứ FE cần để hydrate
    return sendResponseHelper.successResponse(res, {
      data: {
        publicId: outSession.publicId,
        status: outSession.status,
        expiresAt: outSession.expiresAt,
        segments: (outSession.segments || []).map((s) => ({
          direction: s.direction,
          flightScheduleId: s.flightScheduleId,
          seatAssignments: s.seatAssignments || [],
          seatTotalSnapshot: s.seatTotalSnapshot || { currency: "VND", total: 0 },
        })),
        meta: {
          serverTime: new Date().toISOString(),
          remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
        },
      },
    });
  } catch (err) {
    const statusCode = err?._http || 500;
    return sendResponseHelper.errorResponse(res, {
      statusCode,
      errorCode: err?.message || "Internal error",
    });
  } finally {
    mongoSession.endSession();
  }
}
// [PATCH] /api/v1/booking-sessions/:publicId
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function getDirsToCheck(tripType) {
  return tripType === "ROUND_TRIP" ? ["OUTBOUND", "INBOUND"] : ["OUTBOUND"];
}

function validateAndNormalizeContactInfo(contactInfo) {
  if (!contactInfo) {
    throw Object.assign(new Error("contactInfo is required"), { _http: 422 });
  }

  const firstName = String(contactInfo.firstName || "").trim();
  const lastName = String(contactInfo.lastName || "").trim();
  const email = normalizeEmail(contactInfo.email);
  const countryCodeRaw = String(contactInfo.countryCode || "+84").trim();

  // FE đang gửi phone đã nối countryCode + phone
  // => normalize digits để DB nhất quán
  const phoneDigits = normalizeDigits(contactInfo.phone);

  if (!firstName || !lastName) {
    throw Object.assign(new Error("Invalid contact name"), { _http: 422 });
  }
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw Object.assign(new Error("Invalid contact email"), { _http: 422 });
  }
  if (!phoneDigits) {
    throw Object.assign(new Error("Invalid contact phone"), { _http: 422 });
  }

  // có thể normalize countryCode về dạng +84
  const ccDigits = normalizeDigits(countryCodeRaw);
  const countryCode = ccDigits ? `+${ccDigits}` : "+84";

  return {
    firstName,
    lastName,
    email,
    countryCode,
    phone: phoneDigits, // lưu digits
  };
}

/**
 * passengers rules:
 * - passengers must be array length == adults+children+infants
 * - paxIndex must cover 0..total-1 unique
 * - passengerType must match index mapping:
 *   0..adults-1 => ADULT
 *   adults..adults+children-1 => CHILD
 *   rest => INFANT
 * - dateOfBirth must exist, valid, not in future
 */
function validateAndNormalizePassengers(passengers, passengersCount, now = new Date()) {
  const adults = Number(passengersCount?.adults || 0);
  const children = Number(passengersCount?.children || 0);
  const infants = Number(passengersCount?.infants || 0);

  const total = adults + children + infants;
  if (!Array.isArray(passengers) || passengers.length !== total) {
    throw Object.assign(new Error("Passengers count mismatch"), { _http: 422 });
  }

  const seen = new Set();
  const normalized = new Array(total);

  for (const p of passengers) {
    const paxIndex = Number(p.paxIndex);
    if (!Number.isInteger(paxIndex) || paxIndex < 0 || paxIndex >= total) {
      throw Object.assign(new Error("Invalid paxIndex"), { _http: 422 });
    }
    if (seen.has(paxIndex)) {
      throw Object.assign(new Error("Duplicate paxIndex"), { _http: 422 });
    }
    seen.add(paxIndex);

    const firstName = String(p.firstName || "").trim();
    const lastName = String(p.lastName || "").trim();
    if (!firstName || !lastName) {
      throw Object.assign(new Error("Invalid passenger name"), { _http: 422 });
    }

    const dobStr = p.date_of_birth || p.dateOfBirth || null; // FE đang gửi date_of_birth
    const dob = dobStr ? new Date(dobStr) : null;
    if (!dob || Number.isNaN(dob.getTime())) {
      throw Object.assign(new Error("Invalid dateOfBirth"), { _http: 422 });
    }
    if (dob > now) {
      throw Object.assign(new Error("dateOfBirth cannot be in the future"), { _http: 422 });
    }

    const title = String(p.title || "").toUpperCase();
    const gender = String(p.gender || "").toUpperCase();

    // expected passengerType by index
    const expectedType =
      paxIndex < adults ? "ADULT" : paxIndex < adults + children ? "CHILD" : "INFANT";

    const passengerType = String(p.passengerType || expectedType).toUpperCase();
    if (passengerType !== expectedType) {
      throw Object.assign(
        new Error(`passengerType mismatch at paxIndex ${paxIndex} (expected ${expectedType})`),
        { _http: 422 }
      );
    }

    normalized[paxIndex] = {
      paxIndex,
      passengerType,
      title,
      firstName,
      lastName,
      dateOfBirth: dobStr, // lưu string yyyy-mm-dd cho consistent
      fullName: String(p.fullName || `${lastName} ${firstName}`).trim(),
      gender,
    };
  }

  // ensure full coverage
  for (let i = 0; i < total; i++) {
    if (!normalized[i]) {
      throw Object.assign(new Error("Passengers missing paxIndex coverage"), { _http: 422 });
    }
  }

  return normalized;
}

/**
 * seat coverage:
 * - only adult+child need seat
 * - check only dirs per tripType
 * - ensure each paxIndex 0..maxSeatPax-1 has assignment
 * - (strong) verify FlightSeat is held by this session
 */
async function assertSeatCoverageAndHeld(bs, mongoSession) {
  const pc = bs.passengersCount || {};
  const maxSeatPax = Number(pc.adults || 0) + Number(pc.children || 0);
  const dirs = getDirsToCheck(bs.tripType);

  // gather seatIds to verify held
  const seatIdsToVerify = [];

  for (const dir of dirs) {
    const seg = (bs.segments || []).find((s) => s.direction === dir);
    if (!seg) throw Object.assign(new Error(`Segment missing for ${dir}`), { _http: 500 });

    const assigned = new Map(); // paxIndex -> seatId
    for (const a of seg.seatAssignments || []) {
      assigned.set(Number(a.paxIndex), String(a.seatId || ""));
    }

    for (let i = 0; i < maxSeatPax; i++) {
      const sid = assigned.get(i);
      if (!sid) {
        throw Object.assign(new Error(`Missing seat for paxIndex ${i} (${dir})`), { _http: 422 });
      }
      seatIdsToVerify.push(sid);
    }
  }

  // verify all these seats are HELD by this session (atomic safety)
  // (nếu muốn nhẹ hơn có thể bỏ đoạn này)
  const uniqueSeatIds = Array.from(new Set(seatIdsToVerify));

  const seats = await FlightSeat.find({
    _id: { $in: uniqueSeatIds },
    deleted: false,
  })
    .select("_id status blockedBySessionId blockedUntil")
    .session(mongoSession)
    .lean();

  const byId = new Map(seats.map((s) => [String(s._id), s]));
  for (const sid of uniqueSeatIds) {
    const seat = byId.get(String(sid));
    if (!seat) {
      throw Object.assign(new Error("Seat not found while confirming"), { _http: 409 });
    }
    if (String(seat.blockedBySessionId || "") !== String(bs._id)) {
      throw Object.assign(new Error("Seat is not held by this session"), { _http: 409 });
    }
    if (String(seat.status || "").toLowerCase() !== "held") {
      throw Object.assign(new Error("Seat is not in HELD status"), { _http: 409 });
    }
  }
}

// [PATCH] /api/v1/booking-sessions/:publicId
module.exports.updateBookingSession = async (req, res) => {
  const mongoSession = await mongoose.startSession();

  try {
    const { publicId } = req.params;
    const { contactInfo, passengers, client } = req.body || {};

    if (!publicId) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "publicId is required" });
    }

    const now = new Date();
    const ttlMin = Number(process.env.BOOKING_SESSION_TTL_MINUTES || 15);

    let outSession = null;

    await mongoSession.withTransaction(async () => {
      // 1) load session (+secret hash)
      const bs = await BookingSession.findOne({ publicId })
        .select("+sessionSecretHash")
        .session(mongoSession);

      if (!bs) throw Object.assign(new Error("BookingSession not found"), { _http: 404 });
      if (bs.expiresAt && new Date(bs.expiresAt) <= now) throw Object.assign(new Error("BookingSession expired"), { _http: 410 });
      if (["EXPIRED", "CANCELLED"].includes(bs.status)) throw Object.assign(new Error(`BookingSession ${String(bs.status).toLowerCase()}`), { _http: 410 });

      // 2) verify owner (ACCOUNT / GUEST)
      if (bs.ownerType === "ACCOUNT") {
        const userId = req.user?._id;
        if (!userId) throw Object.assign(new Error("Unauthorized"), { _http: 401 });
        if (String(userId) !== String(bs.accountId)) throw Object.assign(new Error("Forbidden"), { _http: 403 });
      } else {
        const guestId = req.cookies?.guest_id;
        const bsToken = req.cookies?.bs_token;

        if (!guestId || !bsToken) throw Object.assign(new Error("Unauthorized (missing guest cookies)"), { _http: 401 });
        if (String(bs.guestId || "") !== String(guestId)) throw Object.assign(new Error("Forbidden (guestId mismatch)"), { _http: 403 });

        const tokenHash = sha256(bsToken);
        if (tokenHash !== bs.sessionSecretHash) throw Object.assign(new Error("Forbidden (invalid session secret)"), { _http: 403 });
      }

      // 3) Confirm idempotency (KHÔNG dùng idempotencyKey của create)
      const idemKey = client?.idempotencyKey ? String(client.idempotencyKey) : null;
      if (!idemKey) {
        throw Object.assign(new Error("client.idempotencyKey is required"), { _http: 422 });
      }

      // nếu đã confirm trước đó với cùng key => trả lại luôn (safe retry)
      if (bs.confirmIdempotencyKey && bs.confirmIdempotencyKey === idemKey) {
        outSession = bs.toObject();
        return;
      }

      // nếu đã set confirm key mà khác => chặn replay “khác key”
      if (bs.confirmIdempotencyKey && bs.confirmIdempotencyKey !== idemKey) {
        throw Object.assign(new Error("Confirm idempotencyKey mismatch"), { _http: 409 });
      }

      // set lần đầu
      bs.confirmIdempotencyKey = idemKey;

      // 4) Validate + normalize contactInfo (required)
      const normalizedContact = validateAndNormalizeContactInfo(contactInfo);

      // 5) Validate + normalize passengers (required)
      const normalizedPassengers = validateAndNormalizePassengers(passengers, bs.passengersCount, now);

      // 6) Validate seat coverage (server truth) + verify held seats belong to this session
      await assertSeatCoverageAndHeld(bs, mongoSession);

      // 7) extend TTL + extend blocked seats blockedUntil
      const newExpiresAt = addMinutes(now, ttlMin);
      bs.expiresAt = newExpiresAt;
      bs.lastActivityAt = now;

      await FlightSeat.updateMany(
        { blockedBySessionId: bs._id, status: "held", deleted: false },
        { $set: { blockedUntil: newExpiresAt } },
        { session: mongoSession }
      );

      // 8) save confirm data
      bs.contactInfo = normalizedContact;
      bs.passengers = normalizedPassengers;

      // status:
      // - đang dùng HOLDING cho “đã hold ghế”
      // - confirm xong vẫn HOLDING, tới khi start payment mới PAYMENT_PENDING
      bs.status = "READY_FOR_PAYMENT";
      bs.confirmedAt = now;

      await bs.save({ session: mongoSession });
      outSession = bs.toObject();
    });

    const remainingMs = outSession?.expiresAt
      ? new Date(outSession.expiresAt).getTime() - Date.now()
      : 0;

    // extend cookie for guest
    if (outSession?.ownerType === "GUEST") {
      const bsToken = req.cookies?.bs_token;
      if (bsToken && outSession?.expiresAt) {
        res.cookie("bs_token", bsToken, {
          httpOnly: true,
          sameSite: "none",
          secure: true,
          maxAge: Math.max(0, remainingMs),
        });
      }
    }

    return sendResponseHelper.successResponse(res, {
      data: {
        publicId: outSession.publicId,
        status: outSession.status,
        expiresAt: outSession.expiresAt,
        contactInfo: outSession.contactInfo,
        passengers: outSession.passengers,
        segments: (outSession.segments || []).map((s) => ({
          direction: s.direction,
          flightScheduleId: s.flightScheduleId,
          seatAssignments: s.seatAssignments || [],
          seatTotalSnapshot: s.seatTotalSnapshot || { currency: "VND", total: 0 },
        })),
        meta: {
          serverTime: new Date().toISOString(),
          remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
        },
      },
    });
  } catch (err) {
    const statusCode = err?._http || 500;
    return sendResponseHelper.errorResponse(res, {
      statusCode,
      errorCode: err?.message || "Internal error",
    });
  } finally {
    mongoSession.endSession();
  }
};