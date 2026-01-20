const sendResponseHelper = require("../../../../helpers/sendResponse.helper");
const { dayRangeByTimezone } = require("../../../../utils/dayRangeByTimezone.util");
const paginationHelper = require("../../../../helpers/objectPagination.helper");

const FlightSchedule = require("../../models/flightSchedule.model");
const Airport = require("../../models/airport.model");
const SeatClass = require("../../models/seatClass.model");

// [GET] /api/v1/flight-schedules/search
module.exports.index = async (req, res) => {
  try {
    const { from, to, date, adults, children, infants, seatClass } = req.query;

    const adultsN = Number(adults || 0);
    const childrenN = Number(children || 0);
    const infantsN = Number(infants || 0);
    const pax = adultsN + childrenN; // nghiệp vụ: cần ghế cho người lớn + trẻ em

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

    // 3) Date range 
    const { start, end } = dayRangeByTimezone(date, fromAirport.timezone || "Asia/Ho_Chi_Minh");

    // OPTION: coi ghế held nhưng đã hết blockedUntil là available
    const INCLUDE_EXPIRED_HELD_AS_AVAILABLE = true;
    const now = new Date();

    /**
     * Base pipeline: lọc đúng ngày + route + có fare seatClass + đủ ghế >= pax
     * -> đồng thời tính totalAdult (giá người lớn) để:
     *    - FE render giá
     *    - facets priceRange/airlines minPrice
     */
    const basePipeline = [
      // schedule đúng ngày
      {
        $match: {
          deleted: false,
          status: "scheduled",
          departureTime: { $gte: start, $lt: end },
        },
      },

      // join flight để lọc route + lấy info flight
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

      // đếm ghế available theo seatClass (qua seat_layouts)
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

      // tính availableCount + giá
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
            $add: ["$priceBreakdown.base", "$priceBreakdown.tax", "$priceBreakdown.serviceFee"],
          },
          durationMinutes: "$flight.durationMinutes",
          airlineId: "$flight.airlineId",
          flightNumber: "$flight.flightNumber",
        },
      },

      // đủ ghế cho pax
      { $match: { availableCount: { $gte: pax } } },
    ];

    /**
     * 4) totalRecord (global, trước pagination)
     */
    const countPipeline = [...basePipeline, { $count: "totalRecord" }];
    const countArr = await FlightSchedule.aggregate(countPipeline);
    const totalRecord = countArr?.[0]?.totalRecord || 0;

    /**
     * 5) pagination object (FULL theo helper của bạn)
     */
    const pagination = paginationHelper.objectPagination(req.query, totalRecord);

    /**
     * 6) data + facets (facets global, rows paginated)
     * - facets tính trên TOÀN BỘ basePipeline (không $skip/$limit)
     * - rows mới có $skip/$limit
     */
    const facetPipeline = [
      ...basePipeline,
      {
        $facet: {
          // ROWS: có sort + skip + limit
          rows: [
            { $sort: { departureTime: 1 } },
            { $skip: pagination.skip },
            { $limit: pagination.limit },

            // join airline để FE render logo/name/code
            {
              $lookup: {
                from: "airlines",
                localField: "airlineId",
                foreignField: "_id",
                as: "airline",
              },
            },
            { $unwind: "$airline" },
            {
              $match: {
                "airline.deleted": false,
                "airline.status": "active",
              },
            },

            // output chuẩn cho FE
            {
              $project: {
                _id: 1,
                flightScheduleId: "$_id",
                flightId: 1,
                airplaneId: 1,
                status: 1,

                // SỬA: Trả về ISO UTC (Mongo sẽ tự serialize thành "2026-01-20T03:00:00.000Z")
                // FE sẽ dùng dayjs.tz hoặc moment-timezone để convert sang local time của airport
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
                  timeZone: fromAirport.timezone || "Asia/Ho_Chi_Minh", // fallback nếu thiếu
                },
                to: {
                  code: toAirport.iataCode,
                  name: toAirport.name,
                  city: toAirport.city,
                  timeZone: toAirport.timezone || "Asia/Ho_Chi_Minh", // fallback nếu thiếu
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

                // nghiệp vụ tạm thời: hiển thị giá theo người lớn = totalAdult
                // (child/infant nếu sau này bạn có rule riêng thì chỉnh lại)
                price: {
                  currency: "VND",
                  adult: "$totalAdult",
                  child: { $round: [{ $multiply: ["$totalAdult", 0.75] }, 0] },
                  infant: { $round: [{ $multiply: ["$totalAdult", 0.1] }, 0] },
                },
              },
            },
          ],

          // FACETS: GLOBAL (không pagination)
          facets: [
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

          // AIRLINES facet: list hãng có trong KẾT QUẢ GLOBAL
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
            {
              $match: {
                "airline.deleted": false,
                "airline.status": "active",
              },
            },
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

    const response = {
      flights: out.rows,
      facets: {
        ...(out.facets || {}),
        airlines: out.airlinesFacet || [],
      },
    };

    return sendResponseHelper.successResponse(res, { data: response, pagination });
  } catch (error) {
    return sendResponseHelper.errorResponse(res, {
      errorCode: error.message,
    });
  }
};