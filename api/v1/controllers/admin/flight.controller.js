const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const Flight = require('../../models/flight.model');
const PaginationHelper = require('../../../../helpers/objectPagination.helper')

// [GET] /api/v1/admin/flights
module.exports.index = async (req, res) => {
  try {
    const condition = {
      deleted: false,
      status: "active"
    }
    // Pagination
    const totalRecords = await Flight.countDocuments(condition);
    const objectPagination = PaginationHelper.objectPagination(req.query, totalRecords);
    const record = await Flight.find(condition)
      .skip(objectPagination.skip)
      .limit(objectPagination.limit);

    sendResponseHelper.successResponse(res, { data: record, pagination: objectPagination });

  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}