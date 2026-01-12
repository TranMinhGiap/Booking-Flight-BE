const express = require('express')
const app = express()

// ==== Config common necessary ====
require('dotenv').config()    // env config => load biến môi trường từ file .env

const database = require('./config/database')  // database config

const cors = require('cors')  // cors config

const cookieParser = require('cookie-parser')   // cookie parser config

const port = process.env.PORT  // port config => lấy biến môi trường PORT từ file .env
// ==== End config common necessary ====

// ==== Middleware common necessary ====
app.use(express.json())   // Đọc dữ liệu từ req.body khi dùng API
app.use(cookieParser())   // Thao tác với cookie
app.use(cors())           // Cors
// ==== End Middleware common necessary ====

// ==== Routes api ====
const routesApiV1Client = require('./api/v1/routes/client/index.route')
const routesApiV1Admin = require('./api/v1/routes/admin/index.route')
// ==== End routes api ====

// ==== Connect to the database ====
database.connect()
// ==== End connect to the database ====

// ==== Subscribe/Start routes ====
routesApiV1Client(app)
routesApiV1Admin(app)
// ==== End subscribe/start routes ====

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})