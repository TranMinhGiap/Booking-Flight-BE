const mongoose = require('mongoose');

// ============== Mongoose ==============
module.exports.connect = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Connect Success");
  } catch (error) {
    console.log("Connect Error !")
  }
}

// ============== End Mongoose ==============