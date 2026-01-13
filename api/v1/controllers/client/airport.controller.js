const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const Airport = require('../../models/airport.model');

// [GET] /api/v1/airport
module.exports.index = async (_, res) => {
  try {
    const record = await Airport.find({ deleted: false, status: "active" });
    sendResponseHelper.successResponse(res, { data: record });
  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}