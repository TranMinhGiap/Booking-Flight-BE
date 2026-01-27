const mongoose = require("mongoose");
const sendResponseHelper = require("../../../../helpers/sendResponse.helper");
const { computeAisles, mapSeatStatus } = require("../../../../helpers/seatMap.helper");
const FlightSchedule = require("../../models/flightSchedule.model");
const SeatClass = require("../../models/seatClass.model");
const SeatLayout = require("../../models/seatLayout.model");
const SeatType = require("../../models/seatType.model");
const FlightSeat = require("../../models/flightSeat.model");

/**
 * Map query seat_class -> SeatClass document
 * Accept:
 * - seatClassId (ObjectId string)
 * - seat_class = "ECONOMY" | "BUSINESS_CLASS" ... (map to className)
 * - seat_class = "Y" | "C" ... (map to classCode)
 */
const resolveSeatClass = async ({ seatClassId, seatClassCode, seat_class }) => {
  // 1) direct seatClassId
  if (seatClassId && mongoose.Types.ObjectId.isValid(seatClassId)) {
    return SeatClass.findOne({ _id: seatClassId, deleted: false, status: "active" }).lean();
  }

  // normalize
  const raw = (seatClassCode || seat_class || "").toString().trim();
  if (!raw) return null;

  // 2) treat as classCode if 1-2 letters (your schema maxlength=2)
  if (/^[A-Z]{1,2}$/i.test(raw)) {
    const code = raw.toUpperCase();
    return SeatClass.findOne({ classCode: code, deleted: false, status: "active" }).lean();
  }

  // 3) treat as className (Economy / Premium Economy / Business Class / First Class)
  // allow common aliases
  const upper = raw.toUpperCase().replace(/\s+/g, "_");
  const map = {
    ECONOMY: "Economy",
    PREMIUM_ECONOMY: "Premium Economy",
    PREMIUMECONOMY: "Premium Economy",
    BUSINESS: "Business Class",
    BUSINESS_CLASS: "Business Class",
    FIRST: "First Class",
    FIRST_CLASS: "First Class",
  };

  const className = map[upper];
  if (!className) return null;

  return SeatClass.findOne({ className, deleted: false, status: "active" }).lean();
}
/**
 * [GET] /api/v1/seats/frontend?flightScheduleId=...&seat_class=ECONOMY
 * Optional:
 * - seatClassId=...
 * - seatClassCode=Y
 */
module.exports.getSeatMap = async (req, res) => {
  try {
    const { flightScheduleId, seatClassId, seatClassCode, seat_class } = req.query;

    if (!flightScheduleId || !mongoose.Types.ObjectId.isValid(String(flightScheduleId))) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "flightScheduleId is required and must be ObjectId",
      });
    }

    // 1) schedule
    const fs = await FlightSchedule.findOne({
      _id: flightScheduleId,
      deleted: false,
      status: { $in: ["scheduled", "delayed"] }, // bạn có thể siết chặt chỉ scheduled
    })
      .select("_id airplaneId status deleted")
      .lean();

    if (!fs) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 404,
        errorCode: "FlightSchedule not found",
      });
    }

    // 2) seat class
    const sc = await resolveSeatClass({ seatClassId, seatClassCode, seat_class });
    if (!sc) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "Invalid seat_class / seatClassId / seatClassCode",
      });
    }

    // 3) load seat types (legend)
    const seatTypesDocs = await SeatType.find({
      seatClassId: sc._id,
      deleted: false,
      status: "active",
    })
      .select("_id code label color basePrice")
      .lean();

    const seatTypeById = new Map(seatTypesDocs.map((t) => [String(t._id), t]));
    const seatTypeByCode = new Map(seatTypesDocs.map((t) => [String(t.code), t]));

    // 4) seat layouts for airplane + seat class
    const layouts = await SeatLayout.find({
      airplaneId: fs.airplaneId,
      seatClassId: sc._id,
      deleted: false,
      status: "active",
    })
      .select("_id seatRow seatColumn seatTypeId seatTypeCode isExitRow isWindow isAisle")
      .lean();

    if (!layouts.length) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 404,
        errorCode: "SeatLayout not found for this airplane + seat class",
      });
    }

    const seatLayoutIds = layouts.map((x) => x._id);

    // * Giải phóng ghế trước khi load SeatMap. 
    // Sau này kêt hợp với cron job định kỳ: Viết một cron job (ví dụ Node.js cron hoặc MongoDB TTL index) chạy mỗi 1-5 phút để cleanup toàn hệ thống
    // => Trong logic build SeatMap (backend hoặc frontend), coi ghế "held" nhưng blockedUntil <= now là "available". (cron chưa kịp chạy)
    await FlightSeat.updateMany(
      {
        flightScheduleId: fs._id,
        status: "held",
        blockedUntil: { $lte: new Date() },
        deleted: false,
      },
      {
        $set: { status: "available" },
        $unset: { blockedBySessionId: 1, blockedAt: 1, blockedUntil: 1 },
      }
    );

    // 5) flight seats for schedule + layouts
    const flightSeats = await FlightSeat.find({
      flightScheduleId: fs._id,
      seatLayoutId: { $in: seatLayoutIds },
      deleted: false,
    })
      .select("_id seatLayoutId status priceAdjustment blockedUntil blockedBySessionId")
      .lean();

    const flightSeatByLayoutId = new Map(
      flightSeats.map((s) => [String(s.seatLayoutId), s])
    );

    // 6) build layout header (rows/cols)
    const columns = Array.from(
      new Set(layouts.map((l) => String(l.seatColumn).toUpperCase()))
    ).sort((a, b) => a.localeCompare(b));

    const rows = Math.max(...layouts.map((l) => Number(l.seatRow || 0)));
    const aisles = computeAisles(columns);

    // 7) build seats array
    const now = new Date();

    const seats = layouts.map((l) => {
      const seatNumber = `${l.seatRow}${String(l.seatColumn).toUpperCase()}`;

      const fsDoc = flightSeatByLayoutId.get(String(l._id));

      // seat type resolve:
      // - prefer seatTypeId
      // - fallback seatTypeCode
      const seatType =
        (l.seatTypeId && seatTypeById.get(String(l.seatTypeId))) ||
        (l.seatTypeCode && seatTypeByCode.get(String(l.seatTypeCode).toUpperCase())) ||
        null;

      const basePrice = Number(seatType?.basePrice || 0);
      const priceAdjustment = Number(fsDoc?.priceAdjustment || 0);
      const effectivePrice = basePrice + priceAdjustment;

      return {
        seatId: fsDoc?._id || null,              // FlightSeat._id (quan trọng để FE gửi lên)
        seatLayoutId: l._id,                     // optional debug
        seatNumber,
        row: l.seatRow,
        column: String(l.seatColumn).toUpperCase(),
        typeCode: seatType?.code || l.seatTypeCode || "STD",
        status: mapSeatStatus(fsDoc, now),       // AVAILABLE / HELD / BOOKED
        price: effectivePrice,                   // giá hiển thị thực tế
        priceAdjustment,                         // optional: FE muốn show breakdown
        flags: {
          isExitRow: !!l.isExitRow,
          isWindow: !!l.isWindow,
          isAisle: !!l.isAisle,
        },
      };
    });

    // 8) legend seatTypes
    const seatTypes = seatTypesDocs.map((t) => ({
      code: t.code,
      label: t.label,
      color: t.color,
      price: Number(t.basePrice || 0), // legend base price
    }));

    return sendResponseHelper.successResponse(res, {
      data: {
        layout: { rows, columns, aisles },
        seatTypes,
        seats,
      },
    });
  } catch (error) {
    return sendResponseHelper.errorResponse(res, {
      statusCode: 500,
      errorCode: error.message,
    });
  }
};