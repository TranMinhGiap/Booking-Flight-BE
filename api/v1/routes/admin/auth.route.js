const express = require("express");
const router = express.Router();

// Controller
const controller = require('../../controllers/admin/auth.controller');

router.get('/', controller.login);

module.exports = router;