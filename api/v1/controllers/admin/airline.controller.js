const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const Airline = require('../../models/airline.model');
const PaginationHelper = require('../../../../helpers/objectPagination.helper')

// [POST] /api/v1/admin/airlines
module.exports.index = async (req, res) => {
  try {
    const condition = {
      deleted: false,
      status: "active"
    }
    // Pagination
    const totalRecords = await Airline.countDocuments(condition);
    const objectPagination = PaginationHelper.objectPagination(req.query, totalRecords);
    const record = await Airline.find(condition)
      .skip(objectPagination.skip)
      .limit(objectPagination.limit);

    sendResponseHelper.successResponse(res, { data: record, pagination: objectPagination });

  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}