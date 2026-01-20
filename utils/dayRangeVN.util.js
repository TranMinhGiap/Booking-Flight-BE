module.exports.dayRangeVN = (dateStr) => {
  const start = new Date(`${dateStr}T00:00:00+07:00`);
  const end = new Date(`${dateStr}T00:00:00+07:00`);
  end.setDate(end.getDate() + 1);
  return { start, end };
}