const sendResponseHelper = require('../../../../helpers/sendResponse.helper');

// [POST] /api/v1/admin/login
module.exports.login = async (req, res) => {
  sendResponseHelper.successResponse(res, { data: "response api login admin" });
}