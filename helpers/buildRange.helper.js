module.exports.buildRange = (minN, maxN) => {
  const hasMin = Number.isFinite(minN);
  const hasMax = Number.isFinite(maxN);
  if (!hasMin && !hasMax) return null;
  if (hasMin && hasMax) return { $gte: minN, $lte: maxN };
  if (hasMin) return { $gte: minN };
  return { $lte: maxN };
}