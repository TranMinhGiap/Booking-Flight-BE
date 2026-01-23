const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/client/bookingSession.controller');

router.get('/:publicId', controller.index);

router.post('/create', controller.create);

module.exports = router;