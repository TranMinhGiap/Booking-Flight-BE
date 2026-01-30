const PaymentMethod = require("../../models/paymentMethod.model");
const sendResponseHelper = require("../../../../helpers/sendResponse.helper");

module.exports.listPaymentMethods = async (req, res) => {
  try {
    const currency = String(req.query.currency || "VND").trim().toUpperCase();

    let amount = null;
    if (req.query.amount != null && String(req.query.amount).trim() !== "") {
      amount = Number(req.query.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return sendResponseHelper.errorResponse(res, {
          statusCode: 400,
          errorCode: "INVALID_AMOUNT",
        });
      }
    }

    const query = { deleted: false, enabled: true };

    query.currencies = currency;

    // amount filter (min/max; 0 nghĩa là no-limit)
    if (amount !== null) {
      query.$and = [
        { $or: [{ minAmount: { $lte: 0 } }, { minAmount: { $lte: amount } }] },
        { $or: [{ maxAmount: { $lte: 0 } }, { maxAmount: { $gte: amount } }] },
      ];
    }

    const methods = await PaymentMethod.find(query)
      .select("code name provider sortOrder minAmount maxAmount currencies publicConfig")
      .sort({ sortOrder: 1 })
      .lean();

    return sendResponseHelper.successResponse(res, {
      data: {
        appliedFilters: { currency, amount, enabled: true, deleted: false },
        methods: methods.map((m) => ({
          code: m.code,
          name: m.name,
          provider: m.provider,
          sortOrder: m.sortOrder,
          minAmount: Number(m.minAmount || 0),
          maxAmount: Number(m.maxAmount || 0),
          currencies: Array.isArray(m.currencies) && m.currencies.length ? m.currencies : ["VND"],
          publicConfig: m.publicConfig ?? null,
        })),
      },
    });
  } catch (err) {
    return sendResponseHelper.errorResponse(res, {
      statusCode: 500,
      errorCode: "INTERNAL_ERROR",
      message: err.message,
    });
  }
};