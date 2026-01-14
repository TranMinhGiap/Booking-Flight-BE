const mongoose = require("mongoose");
const sendResponseHelper = require('../../../../helpers/sendResponse.helper');
const SeatLayout = require('../../models/seatLayout.model');

// [GET] /api/v1/admin/seat-layouts/:id
module.exports.index = async (req, res) => {

  const { id } = req.params;

  try {
    const condition = {
      airplaneId: new mongoose.Types.ObjectId(id),
      deleted: false,
      status: "active"
    }

    const records = await SeatLayout.find(condition);

    sendResponseHelper.successResponse(res, { data: records });

  } catch (error) {
    sendResponseHelper.errorResponse(res, {
      errorCode: error.message
    });
  }
}