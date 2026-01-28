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
          errorCode: "amount must be a non-negative number",
        });
      }
    }

    // Hard-code cho public API, hoặc thêm parseBool(enabled) nếu cần linh hoạt
    const methods = await PaymentMethod.find({ deleted: false, enabled: true })
      .select("code name provider sortOrder minAmount maxAmount currencies publicConfig")
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const filtered = methods.filter((m) => {
      const currencies = Array.isArray(m.currencies) && m.currencies.length
        ? m.currencies.map(c => String(c).toUpperCase())
        : ["VND"];

      if (!currencies.includes(currency)) return false;

      if (amount !== null) {
        const minA = Number(m.minAmount || 0);
        const maxA = Number(m.maxAmount || 0);
        if (minA > 0 && amount < minA) return false;
        if (maxA > 0 && amount > maxA) return false;
      }

      return true;
    });

    return sendResponseHelper.successResponse(res, {
      data: {
        appliedFilters: { currency, amount, enabled: true, deleted: false },
        methods: filtered.map((m) => ({
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
      errorCode: err?.message || "Internal error",
    });
  }
};