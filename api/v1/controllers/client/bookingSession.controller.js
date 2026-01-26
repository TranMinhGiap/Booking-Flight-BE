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
      // Sau này thêm giá thành viên sau
      const childUnit = Math.round(adultUnit * 0.75);
      const infantUnit = Math.round(adultUnit * 0.1);

      const total = pax.adults * adultUnit + pax.children * childUnit + pax.infants * infantUnit;

      //  grand snapshot theo TỔNG tiền từng loại pax
      grand.adult += pax.adults * adultUnit;
      grand.child += pax.children * childUnit;
      grand.infant += pax.infants * infantUnit;
      grand.total += total;

      builtSegments.push({
        direction: seg.direction,        // OUTBOUND / INBOUND
        flightScheduleId: fs._id,
        seatClassCode,                   // snapshot code
        seatClassId: seatClassDoc._id,   // id
        seatAssignments: [],
        seatTotalSnapshot: { currency: "VND", total: 0 },
        // base fare snapshot (not include seat fee)
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
      contactInfo: {},
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