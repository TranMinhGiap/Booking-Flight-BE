const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/client/seatMap.controller');

router.get('/', controller.getSeatMap);

module.exports = router;