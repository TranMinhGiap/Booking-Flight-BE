module.exports.addMinutes = (date, minutes) => {
  return new Date(date.getTime() + minutes * 60 * 1000);
}