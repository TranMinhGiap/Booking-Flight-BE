const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/admin/seatLayout.controller');

router.get('/:id', controller.index);

module.exports = router;