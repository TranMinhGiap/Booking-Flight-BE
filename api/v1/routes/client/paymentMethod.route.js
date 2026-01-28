const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/client/paymentMethod.controller');

router.get('/', controller.listPaymentMethods);

module.exports = router;