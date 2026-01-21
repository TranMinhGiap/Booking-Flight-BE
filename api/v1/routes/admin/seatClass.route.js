const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/admin/seatClass.controller');

router.get('/:classCode', controller.index);

module.exports = router;