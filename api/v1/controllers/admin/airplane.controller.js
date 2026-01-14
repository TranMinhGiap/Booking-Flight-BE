const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const Airplane = require('../../models/airplane.model');
const PaginationHelper = require('../../../../helpers/objectPagination.helper')

// [GET] /api/v1/admin/airplanes
module.exports.index = async (req, res) => {
  try {
    const condition = {
      deleted: false,
      status: "active"
    }
    // Pagination
    const totalRecords = await Airplane.countDocuments(condition);
    const objectPagination = PaginationHelper.objectPagination(req.query, totalRecords);
    const record = await Airplane.find(condition)
      .skip(objectPagination.skip)
      .limit(objectPagination.limit);

    sendResponseHelper.successResponse(res, { data: record, pagination: objectPagination });

  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}