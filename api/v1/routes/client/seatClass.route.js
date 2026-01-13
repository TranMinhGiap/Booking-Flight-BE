const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/client/seatClass.controller');

router.get('/', controller.index);

module.exports = router;