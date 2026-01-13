const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/admin/flight.controller');

router.get('/', controller.index);

module.exports = router;