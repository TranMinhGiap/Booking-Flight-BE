module.exports.parseWindows = (raw) => {
  // raw: "0-360,720-1080" or "1080-120" (qua ngày)
  const out = [];

  String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [aRaw, bRaw] = pair.split("-");
      const a = Number(aRaw);
      const b = Number(bRaw);

      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      if (a < 0 || a > 1440 || b < 0 || b > 1440) return;
      if (a === b) return;

      // bình thường
      if (a < b) {
        out.push({ start: a, end: b });
        return;
      }

      // qua ngày: a > b => tách làm 2 đoạn
      out.push({ start: a, end: 1440 });
      out.push({ start: 0, end: b });
    });

  return out;
};