const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const SeatClass = require('../../models/seatClass.model');

// [GET] /api/v1/seatClass
module.exports.index = async (_, res) => {
  try {
    const record = await SeatClass.find({ deleted: false, status: "active" });
    sendResponseHelper.successResponse(res, { data: record });
  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}