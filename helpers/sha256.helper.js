const crypto = require("crypto");

module.exports.sha256 = (input) => {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}