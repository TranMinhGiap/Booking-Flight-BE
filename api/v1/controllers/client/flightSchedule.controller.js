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

// [GET] /api/v1/flight-schedules/search
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

      // server-side filters
      airlines, // "VN,VJ"
      minPrice,
      maxPrice,
      minDuration,
      maxDuration,
      sort,
      depWindows,
      arrWindows,
    } = req.query;

    const adultsN = Number(adults || 0);
    const childrenN = Number(children || 0);
    const infantsN = Number(infants || 0);
    const pax = adultsN + childrenN; // cần ghế cho người lớn + trẻ em

    const sortSpec = buildSortSpec(sort);

    // 1) Validate airports
    const [fromAirport, toAirport] = await Promise.all([
      Airport.findOne({ iataCode: from, deleted: false, status: "active" }).lean(),
      Airport.findOne({ iataCode: to, deleted: false, status: "active" }).lean(),
    ]);
    if (!fromAirport || !toAirport) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "Invalid from/to IATA",
      });
    }

    // 2) Validate seatClass
    const seatClassDoc = await SeatClass.findOne({
      classCode: seatClass,
      deleted: false,
      status: "active",
    }).lean();
    if (!seatClassDoc) {
      return sendResponseHelper.errorResponse(res, {
        statusCode: 400,
        errorCode: "Invalid seatClass",
      });
    }

    // 3) Date range theo timezone sân bay đi (from)
    const { start, end } = dayRangeByTimezone(
      date,
      fromAirport.timezone || "Asia/Ho_Chi_Minh"
    );

    // OPTION: coi ghế held nhưng đã hết blockedUntil là available
    const INCLUDE_EXPIRED_HELD_AS_AVAILABLE = true;
    const now = new Date();

    // 4) Parse filter params
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

    // nếu có filter airlines bằng code -> convert sang airlineIds
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

      // user gửi airlineCodes nhưng không map ra id nào => 0 kết quả
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

    const matchAirlineFilter = airlineIds.length
      ? { airlineId: { $in: airlineIds } }
      : null;

    // ====== TÁCH FILTER: non-airline vs airline ======
    const andFilters = [];

    const priceQ = buildRange(minPriceN, maxPriceN);
    if (priceQ) andFilters.push({ totalAdult: priceQ });

    const durQ = buildRange(minDurationN, maxDurationN);
    if (durQ) andFilters.push({ durationMinutes: durQ });

    // depWindows / arrWindows (lọc theo khung giờ)
    if (depOr.length) andFilters.push({ $or: depOr });
    if (arrOr.length) andFilters.push({ $or: arrOr });

    const matchNonAirlineFilters = andFilters.length ? { $and: andFilters } : {};

    /**
     * baseCore: chỉ filter core (date/route/seatClass/pax/available) + tính fields
     * KHÔNG áp airline/price/duration ở đây
     */
    const baseCore = [
      {
        $match: {
          deleted: false,
          status: "scheduled",
          departureTime: { $gte: start, $lt: end },
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

      // đếm ghế available theo seatClass
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

      // tính availableCount + totalAdult + duration + airlineId + flightNumber
      {
        $addFields: {
          availableCount: {
            $ifNull: [{ $arrayElemAt: ["$seatStats.availableCount", 0] }, 0],
          },
          priceBreakdown: {
            base: { $arrayElemAt: ["$fare.basePrice", 0] },
            tax: { $arrayElemAt: ["$fare.tax", 0] },
            serviceFee: { $arrayElemAt: ["$fare.serviceFee", 0] },
          },
        },
      },
      {
        $addFields: {
          totalAdult: {
            $add: [
              "$priceBreakdown.base",
              "$priceBreakdown.tax",
              "$priceBreakdown.serviceFee",
            ],
          },
          durationMinutes: "$flight.durationMinutes",
          airlineId: "$flight.airlineId",
          flightNumber: "$flight.flightNumber",
        },
      },
      {
        $addFields: {
          _depParts: {
            $dateToParts: {
              date: "$departureTime",
              timezone: fromAirport.timezone || "Asia/Ho_Chi_Minh",
            },
          },
          _arrParts: {
            $dateToParts: {
              date: "$arrivalTime",
              timezone: toAirport.timezone || "Asia/Ho_Chi_Minh",
            },
          },
        },
      },
      {
        $addFields: {
          depMinuteOfDay: {
            $add: [{ $multiply: ["$_depParts.hour", 60] }, "$_depParts.minute"],
          },
          arrMinuteOfDay: {
            $add: [{ $multiply: ["$_arrParts.hour", 60] }, "$_arrParts.minute"],
          },
        },
      },

      // đủ ghế
      { $match: { availableCount: { $gte: pax } } },
    ];

    // ====== totalRecord: áp full filter (non-airline + airline) ======
    const countPipeline = [
      ...baseCore,
      ...(Object.keys(matchNonAirlineFilters).length ? [{ $match: matchNonAirlineFilters }] : []),
      ...(matchAirlineFilter ? [{ $match: matchAirlineFilter }] : []),
      { $count: "totalRecord" },
    ];
    const countArr = await FlightSchedule.aggregate(countPipeline);
    const totalRecord = countArr?.[0]?.totalRecord || 0;

    const pagination = paginationHelper.objectPagination(req.query, totalRecord);

    // ====== facetPipeline: airlinesFacet bỏ airline filter ======
    const facetPipeline = [
      ...baseCore,
      // áp non-airline filters cho TẤT CẢ nhánh (rows/facets/airlinesFacet)
      ...(Object.keys(matchNonAirlineFilters).length ? [{ $match: matchNonAirlineFilters }] : []),

      {
        $facet: {
          // ROWS: áp airline filter
          rows: [
            ...(matchAirlineFilter ? [{ $match: matchAirlineFilter }] : []),
            { $sort: sortSpec },
            { $skip: pagination.skip },
            { $limit: pagination.limit },

            {
              $lookup: {
                from: "airlines",
                localField: "airlineId",
                foreignField: "_id",
                as: "airline",
              },
            },
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
                  timeZone: fromAirport.timezone || "Asia/Ho_Chi_Minh",
                },
                to: {
                  code: toAirport.iataCode,
                  name: toAirport.name,
                  city: toAirport.city,
                  timeZone: toAirport.timezone || "Asia/Ho_Chi_Minh",
                },

                cabinClass: {
                  code: seatClassDoc.classCode,
                  name: seatClassDoc.className,
                },

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

          // facets price/duration: theo kết quả đang lọc (có airline filter)
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

          // airlinesFacet: KHÔNG matchAirlineFilter => luôn đủ option theo các filter khác
          airlinesFacet: [
            {
              $group: {
                _id: "$airlineId",
                count: { $sum: 1 },
                minPrice: { $min: "$totalAdult" },
              },
            },
            {
              $lookup: {
                from: "airlines",
                localField: "_id",
                foreignField: "_id",
                as: "airline",
              },
            },
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

    // fallback khi 0 record
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
      errorCode: error.message,
    });
  }
};