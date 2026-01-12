const successResponse = (
  res,
  { data = null, message = "Request successful", statusCode = 200, pagination } = {}
) => {
  const response = {
    success: true,
    statusCode,
    message,
    data,
    ...(pagination ? { pagination } : {}),
  };

  return res.status(statusCode).json(response);
};

const errorResponse = (
  res,
  { statusCode = 500, message = "Request failed, something went wrong", errorCode, details } = {}
) => {
  const response = {
    success: false,
    statusCode,
    message,
    ...(errorCode ? { error: { code: errorCode } } : {}),
    ...(details ? { details } : {}), 
  };

  return res.status(statusCode).json(response);
};

module.exports = { successResponse, errorResponse };
