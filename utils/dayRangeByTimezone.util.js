const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(tz);

module.exports.dayRangeByTimezone = (dateStr, timezone) => {
  const startLocal = dayjs.tz(`${dateStr} 00:00:00`, timezone);
  const endLocal = startLocal.add(1, "day");
  return {
    start: startLocal.toDate(), // Date UTC
    end: endLocal.toDate(),
  };
};


// có thể thêm validate để tránh lỗi:
// const dayjs = require("dayjs");
// const utc = require("dayjs/plugin/utc");
// const timezone = require("dayjs/plugin/timezone"); 
// dayjs.extend(utc);
// dayjs.extend(timezone);

// module.exports.dayRangeByTimezone = (dateStr, tz = "Asia/Ho_Chi_Minh") => {
//   if (!dateStr || !dayjs(`${dateStr} 00:00:00`, { format: "YYYY-MM-DD HH:mm:ss" }).isValid()) {
//     throw new Error("Invalid date format"); // hoặc handle theo cách bạn muốn
//   }

//   const startLocal = dayjs.tz(`${dateStr} 00:00:00`, "YYYY-MM-DD HH:mm:ss", tz);
//   const endLocal = startLocal.add(1, "day");

//   return {
//     start: startLocal.toDate(), // UTC Date
//     end: endLocal.toDate(),     // UTC Date
//   };
// };
