const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/client/flightSchedule.controller');

router.get('/search', controller.index);

module.exports = router;