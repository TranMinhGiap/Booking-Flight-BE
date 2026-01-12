const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/client/auth.controller');

router.get('/', controller.login);

module.exports = router;