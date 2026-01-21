const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const SeatClass = require('../../models/seatClass.model');

// [GET] /api/v1/admin/seat-classes/:classCode
module.exports.index = async (req, res) => {
  try {
    const condition = {
      classCode: req.params.classCode,
      deleted: false,
      status: "active"
    }
    
    const record = await SeatClass.findOne(condition);

    sendResponseHelper.successResponse(res, { data: record });

  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}