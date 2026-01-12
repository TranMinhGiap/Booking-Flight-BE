const sendResponseHelper = require('../../../../helpers/sendResponse.helper');

// [POST] /api/v1/users/login
module.exports.login = async (req, res) => {
  sendResponseHelper.successResponse(res, { data: "response api login client" });
}