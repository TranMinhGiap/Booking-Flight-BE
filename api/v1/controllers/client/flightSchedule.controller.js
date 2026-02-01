const sendResponseHelper = require("../../../../helpers/sendResponse.helper");
const { dayRangeByTimezone } = require("../../../../utils/dayRangeByTimezone.util");
const paginationHelper = require("../../../../helpers/objectPagination.helper");
const { buildRange } = require("../../../../helpers/buildRange.helper");
const { buildSortSpec } = require("../../../../helpers/buildSortSpec.helper");
const { parseWindows } = require("../../../../helpers/parseWindows.helper");

const FlightSchedule = require("../../models/flightSchedule.model");
const Airport = require("../../models/airport.model");
const SeatClass = require("../../models/seatClass.model");
const Airline = require("../../models/airline.model");
const Flight = require("../../models/flight.model");

// [GET] /api/v1/flight-schedules/search

// Version New (đảm bảo search > thời gian hiện tại, không quá sát giờ)
// ==============================
// CONFIG
// ==============================
const INCLUDE_EXPIRED_HELD_AS_AVAILABLE = true;

// Optional: chặn đặt chuyến “sát giờ” (vd 10 phút)
// nếu không muốn thì để 0
const MIN_BOOKING_LEAD_MINUTES = Number(process.env.MIN_BOOKING_LEAD_MINUTES || 60);

// turnaround phút tối thiểu giữa outbound arrival và inbound departure
const MIN_TURNAROUND_MINUTES = Number(process.env.MIN_TURNAROUND_MINUTES || 60);

// ==============================
// HELPERS
// ==============================
function normalizeSeatClassCode(code) {
  return String(code || "").trim().toUpperCase();
}

function normalizeIata(code) {
  return String(code || "").trim().toUpperCase();
}

// dateStr có thể "YYYY-MM-DD" hoặc "DD/MM/YYYY"
function normalizeInputDateToYMD(dateStr) {
  const s = String(dateStr || "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const dd = m[1],
      mm = m[2],
      yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // fallback parse
  const t = new Date(s);
  if (!Number.isNaN(t.getTime())) {
    const yyyy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(t.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

// YYYY-MM-DD theo timezone
function ymdInTz(dateObj, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(dateObj); // "2026-02-01"
}

function isSameObjectId(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

// ==============================
// CONTROLLER
// ==============================
module.exports.index = async (req, res) => {
  try {
    const {
      from,
      to,
      date,
      adults,
      children,
      infants,
      seatClass,

      // CHẶT NHẤT: inbound sẽ gửi outboundScheduleId
      outboundScheduleId,

      // fallback (optional): FE có thể gửi minDepartAt, BE chỉ coi như fallback
      minDepartAt,

      // filters
      airlines, // "VN,VJ"
      minPrice,
      maxPrice,
      minDuration,
      maxDuration,
      sort,
      depWindows,
      arrWindows,
    } = req.query;

    const fromIata = normalizeIata(from);
    const toIata = normalizeIata(to);

    const adultsN = Number(adults || 0);
    const childrenN = Number(children || 0);
    const infantsN = Number(infants || 0);

    // nghiệp vụ: cần ghế cho người lớn + trẻ em
    const paxNeedSeat = adultsN + childrenN;

    // validate cơ bản
    if (!fromIata || !toIata || !date || !seatClass) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "Missing required params: from, to, date, seatClass",
      });
    }
    if (!Number.isFinite(adultsN) || adultsN < 1) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid adults (must be >= 1)" });
    }
    if (!Number.isFinite(childrenN) || childrenN < 0) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid children" });
    }
    if (!Number.isFinite(infantsN) || infantsN < 0) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid infants" });
    }
    if (infantsN > adultsN) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Infants cannot exceed adults" });
    }

    const sortSpec = buildSortSpec(sort);

    // 1) Validate airports
    const [fromAirport, toAirport] = await Promise.all([
      Airport.findOne({ iataCode: fromIata, deleted: false, status: "active" }).lean(),
      Airport.findOne({ iataCode: toIata, deleted: false, status: "active" }).lean(),
    ]);

    if (!fromAirport || !toAirport) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "Invalid from/to IATA",
      });
    }

    // 2) Validate seatClass
    const seatClassDoc = await SeatClass.findOne({
      classCode: normalizeSeatClassCode(seatClass),
      deleted: false,
      status: "active",
    }).lean();

    if (!seatClassDoc) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid seatClass" });
    }

    const tzFrom = fromAirport.timezone || "Asia/Ho_Chi_Minh";

    // 3) Date range theo timezone sân bay đi (from)
    // ⚠️ Bạn nên dùng helper dayRangeByTimezone của project bạn thay cho fallback ở trên
    const { start, end } = dayRangeByTimezone(date, tzFrom);

    // 4) Derived minDepartAt từ outboundScheduleId (CHẶT NHẤT)
    let derivedMinDepartAt = null;

    if (outboundScheduleId) {
      const outFs = await FlightSchedule.findOne({
        _id: outboundScheduleId,
        deleted: false,
        status: { $in: ["scheduled", "delayed"] },
      }).lean();

      if (!outFs) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid outboundScheduleId" });
      }

      const outFlight = await Flight.findOne({
        _id: outFs.flightId,
        deleted: false,
        status: "active",
      }).lean();

      if (!outFlight) {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Outbound flight not found/inactive" });
      }

      // inbound request (fromAirport -> toAirport)
      // outbound phải là chiều ngược lại: toAirport -> fromAirport
      const reversedOk =
        isSameObjectId(outFlight.departureAirportId, toAirport._id) &&
        isSameObjectId(outFlight.arrivalAirportId, fromAirport._id);

      if (!reversedOk) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 400,
          errorCode: "outboundScheduleId is not reverse of requested route",
        });
      }

      derivedMinDepartAt = new Date(outFs.arrivalTime.getTime() + MIN_TURNAROUND_MINUTES * 60 * 1000);
    }

    // 5) minDepartAt fallback (FE gửi) — BE chỉ coi như fallback
    let minDepartAtDate = null;
    if (minDepartAt) {
      const t = new Date(minDepartAt);
      if (!Number.isNaN(t.getTime())) {
        minDepartAtDate = t;
      } else {
        return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid minDepartAt" });
      }
    }

    // 6) depStart = max(start, derivedMinDepartAt, minDepartAtDate)
    let depStart = start;

    if (derivedMinDepartAt && derivedMinDepartAt > depStart) depStart = derivedMinDepartAt;
    if (minDepartAtDate && minDepartAtDate > depStart) depStart = minDepartAtDate;

    // 7) CHẶN “CHUYẾN ĐÃ BAY” KHI SEARCH HÔM NAY (theo tzFrom)
    const now = new Date();
    const qYmd = normalizeInputDateToYMD(date);
    if (!qYmd) {
      return sendResponseHelper.errorResponse(res, { statusCode: 400, errorCode: "Invalid date format" });
    }
    const todayYmd = ymdInTz(now, tzFrom);
    const isSearchingToday = qYmd === todayYmd;

    if (isSearchingToday) {
      const nowWithLead = new Date(now.getTime() + MIN_BOOKING_LEAD_MINUTES * 60 * 1000);
      if (nowWithLead > depStart) depStart = nowWithLead;
    }

    // Nếu depStart >= end => ngày đó không còn chuyến nào hợp lệ
    if (depStart >= end) {
      const pagination = paginationHelper.objectPagination(req.query, 0);
      return sendResponseHelper.successResponse(res, {
        data: {
          flights: [],
          facets: {
            priceRange: { min: 0, max: 0, currency: "VND" },
            durationRange: { min: 0, max: 0 },
            airlines: [],
          },
        },
        pagination,
      });
    }

    // 8) Parse filters
    const minPriceN = Number(minPrice);
    const maxPriceN = Number(maxPrice);
    const minDurationN = Number(minDuration);
    const maxDurationN = Number(maxDuration);

    const depWin = parseWindows(depWindows);
    const arrWin = parseWindows(arrWindows);

    const depOr = depWin.map(({ start, end }) => ({
      depMinuteOfDay: { $gte: start, $lt: end },
    }));

    const arrOr = arrWin.map(({ start, end }) => ({
      arrMinuteOfDay: { $gte: start, $lt: end },
    }));

    const airlineCodes = String(airlines || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    // convert airlineCodes -> airlineIds
    let airlineIds = [];
    if (airlineCodes.length) {
      const found = await Airline.find({
        deleted: false,
        status: "active",
        iataCode: { $in: airlineCodes },
      })
        .select("_id")
        .lean();

      airlineIds = found.map((x) => x._id);

      if (!airlineIds.length) {
        const pagination = paginationHelper.objectPagination(req.query, 0);
        return sendResponseHelper.successResponse(res, {
          data: {
            flights: [],
            facets: {
              priceRange: { min: 0, max: 0, currency: "VND" },
              durationRange: { min: 0, max: 0 },
              airlines: [],
            },
          },
          pagination,
        });
      }
    }

    const matchAirlineFilter = airlineIds.length ? { airlineId: { $in: airlineIds } } : null;

    // non-airline filters
    const andFilters = [];

    const priceQ = buildRange(minPriceN, maxPriceN);
    if (priceQ) andFilters.push({ totalAdult: priceQ });

    const durQ = buildRange(minDurationN, maxDurationN);
    if (durQ) andFilters.push({ durationMinutes: durQ });

    if (depOr.length) andFilters.push({ $or: depOr });
    if (arrOr.length) andFilters.push({ $or: arrOr });

    const matchNonAirlineFilters = andFilters.length ? { $and: andFilters } : {};

    // ==============================
    // AGG PIPELINE CORE
    // ==============================
    const baseCore = [
      {
        $match: {
          deleted: false,
          status: { $in: ["scheduled", "delayed"] },

          // depStart đã gồm: start + inbound turnaround (derived/fallback) + today(now)
          departureTime: { $gte: depStart, $lt: end },
        },
      },

      // join flight để lọc route
      {
        $lookup: {
          from: "flights",
          localField: "flightId",
          foreignField: "_id",
          as: "flight",
        },
      },
      { $unwind: "$flight" },
      {
        $match: {
          "flight.deleted": false,
          "flight.status": "active",
          "flight.departureAirportId": fromAirport._id,
          "flight.arrivalAirportId": toAirport._id,
        },
      },

      // fare theo seatClass
      {
        $lookup: {
          from: "flight_fares",
          let: { sid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$flightScheduleId", "$$sid"] },
                    { $eq: ["$seatClassId", seatClassDoc._id] },
                    { $eq: ["$deleted", false] },
                  ],
                },
              },
            },
            { $project: { basePrice: 1, tax: 1, serviceFee: 1 } },
          ],
          as: "fare",
        },
      },
      { $match: { "fare.0": { $exists: true } } },

      // seat availability
      {
        $lookup: {
          from: "flight_seats",
          let: { sid: "$_id", apid: "$airplaneId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$flightScheduleId", "$$sid"] },
                    { $eq: ["$deleted", false] },
                    INCLUDE_EXPIRED_HELD_AS_AVAILABLE
                      ? {
                          $or: [
                            { $eq: ["$status", "available"] },
                            {
                              $and: [
                                { $eq: ["$status", "held"] },
                                { $ne: ["$blockedUntil", null] },
                                { $lt: ["$blockedUntil", now] },
                              ],
                            },
                          ],
                        }
                      : { $eq: ["$status", "available"] },
                  ],
                },
              },
            },
            {
              $lookup: {
                from: "seat_layouts",
                localField: "seatLayoutId",
                foreignField: "_id",
                as: "layout",
              },
            },
            { $unwind: "$layout" },
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$layout.deleted", false] },
                    { $eq: ["$layout.status", "active"] },
                    { $eq: ["$layout.seatClassId", seatClassDoc._id] },
                    { $eq: ["$layout.airplaneId", "$$apid"] },
                  ],
                },
              },
            },
            { $count: "availableCount" },
          ],
          as: "seatStats",
        },
      },

      // compute prices + fields
      {
        $addFields: {
          availableCount: { $ifNull: [{ $arrayElemAt: ["$seatStats.availableCount", 0] }, 0] },
          priceBreakdown: {
            base: { $arrayElemAt: ["$fare.basePrice", 0] },
            tax: { $arrayElemAt: ["$fare.tax", 0] },
            serviceFee: { $arrayElemAt: ["$fare.serviceFee", 0] },
          },
        },
      },
      {
        $addFields: {
          totalAdult: { $add: ["$priceBreakdown.base", "$priceBreakdown.tax", "$priceBreakdown.serviceFee"] },
          airlineId: "$flight.airlineId",
          flightNumber: "$flight.flightNumber",
        },
      },

      // minute-of-day for windows
      {
        $addFields: {
          _depParts: { $dateToParts: { date: "$departureTime", timezone: tzFrom } },
          _arrParts: { $dateToParts: { date: "$arrivalTime", timezone: toAirport.timezone || "Asia/Ho_Chi_Minh" } },
        },
      },
      {
        $addFields: {
          depMinuteOfDay: { $add: [{ $multiply: ["$_depParts.hour", 60] }, "$_depParts.minute"] },
          arrMinuteOfDay: { $add: [{ $multiply: ["$_arrParts.hour", 60] }, "$_arrParts.minute"] },
        },
      },

      // duration dynamic
      { $addFields: { durationMs: { $subtract: ["$arrivalTime", "$departureTime"] } } },
      {
        $addFields: {
          durationMinutes: {
            $cond: {
              if: { $gte: ["$durationMs", 0] },
              then: { $round: [{ $divide: ["$durationMs", 60000] }] },
              else: "$flight.durationMinutes",
            },
          },
        },
      },

      // đủ ghế (adult+child)
      { $match: { availableCount: { $gte: paxNeedSeat } } },
    ];

    // ==============================
    // COUNT
    // ==============================
    const countPipeline = [
      ...baseCore,
      ...(Object.keys(matchNonAirlineFilters).length ? [{ $match: matchNonAirlineFilters }] : []),
      ...(matchAirlineFilter ? [{ $match: matchAirlineFilter }] : []),
      { $count: "totalRecord" },
    ];

    const countArr = await FlightSchedule.aggregate(countPipeline);
    const totalRecord = countArr?.[0]?.totalRecord || 0;

    const pagination = paginationHelper.objectPagination(req.query, totalRecord);

    // ==============================
    // FACET
    // ==============================
    const facetPipeline = [
      ...baseCore,
      ...(Object.keys(matchNonAirlineFilters).length ? [{ $match: matchNonAirlineFilters }] : []),

      {
        $facet: {
          rows: [
            ...(matchAirlineFilter ? [{ $match: matchAirlineFilter }] : []),
            { $sort: sortSpec },
            { $skip: pagination.skip },
            { $limit: pagination.limit },

            { $lookup: { from: "airlines", localField: "airlineId", foreignField: "_id", as: "airline" } },
            { $unwind: "$airline" },
            { $match: { "airline.deleted": false, "airline.status": "active" } },

            {
              $project: {
                _id: 1,
                flightScheduleId: "$_id",
                flightId: 1,
                airplaneId: 1,
                status: 1,

                departureAt: "$departureTime",
                arrivalAt: "$arrivalTime",

                durationMinutes: 1,
                flightNumber: 1,

                airline: {
                  id: "$airline._id",
                  code: "$airline.iataCode",
                  name: "$airline.name",
                  logoUrl: "$airline.logoUrl",
                },

                from: {
                  code: fromAirport.iataCode,
                  name: fromAirport.name,
                  city: fromAirport.city,
                  timeZone: tzFrom,
                },
                to: {
                  code: toAirport.iataCode,
                  name: toAirport.name,
                  city: toAirport.city,
                  timeZone: toAirport.timezone || "Asia/Ho_Chi_Minh",
                },

                cabinClass: { code: seatClassDoc.classCode, name: seatClassDoc.className },

                seatsAvailable: "$availableCount",

                priceBreakdown: {
                  base: "$priceBreakdown.base",
                  tax: "$priceBreakdown.tax",
                  serviceFee: "$priceBreakdown.serviceFee",
                  totalAdult: "$totalAdult",
                },

                // rule tạm thời
                price: {
                  currency: "VND",
                  adult: "$totalAdult",
                  child: { $round: [{ $multiply: ["$totalAdult", 0.75] }, 0] },
                  infant: { $round: [{ $multiply: ["$totalAdult", 0.1] }, 0] },
                },
              },
            },
          ],

          facets: [
            ...(matchAirlineFilter ? [{ $match: matchAirlineFilter }] : []),
            {
              $group: {
                _id: null,
                minPrice: { $min: "$totalAdult" },
                maxPrice: { $max: "$totalAdult" },
                minDuration: { $min: "$durationMinutes" },
                maxDuration: { $max: "$durationMinutes" },
              },
            },
            {
              $project: {
                _id: 0,
                priceRange: { min: "$minPrice", max: "$maxPrice", currency: "VND" },
                durationRange: { min: "$minDuration", max: "$maxDuration" },
              },
            },
          ],

          // airlinesFacet: bỏ airline filter => luôn đủ options
          airlinesFacet: [
            {
              $group: {
                _id: "$airlineId",
                count: { $sum: 1 },
                minPrice: { $min: "$totalAdult" },
              },
            },
            { $lookup: { from: "airlines", localField: "_id", foreignField: "_id", as: "airline" } },
            { $unwind: "$airline" },
            { $match: { "airline.deleted": false, "airline.status": "active" } },
            {
              $project: {
                _id: 0,
                id: "$airline._id",
                code: "$airline.iataCode",
                name: "$airline.name",
                logoUrl: "$airline.logoUrl",
                count: 1,
                minPrice: 1,
                currency: "VND",
              },
            },
            { $sort: { minPrice: 1 } },
          ],
        },
      },

      {
        $project: {
          rows: 1,
          facets: { $ifNull: [{ $arrayElemAt: ["$facets", 0] }, {}] },
          airlinesFacet: 1,
        },
      },
    ];

    const facetArr = await FlightSchedule.aggregate(facetPipeline);
    const out = facetArr?.[0] || { rows: [], facets: {}, airlinesFacet: [] };

    const safeFacets = out.facets?.priceRange
      ? out.facets
      : {
          priceRange: { min: 0, max: 0, currency: "VND" },
          durationRange: { min: 0, max: 0 },
        };

    return sendResponseHelper.successResponse(res, {
      data: {
        flights: out.rows || [],
        facets: {
          ...(safeFacets || {}),
          airlines: out.airlinesFacet || [],
        },
      },
      pagination,
    });
  } catch (error) {
    return sendResponseHelper.errorResponse(res, {
      statusCode: 500,
      errorCode: error?.message || "Internal error",
    });
  }
};