/**
 * Heuristic aisles: if 6 columns -> aisle after 3, if 4 -> after 2
 * FE vẫn chạy tốt nếu aisles=[]
 */
const computeAisles = (columns) => {
  const n = columns.length;
  switch (n) {
    case 4:
      return [2];      // A B | C D
    case 5:
      return [1, 4];   // A | B C D | E (ít gặp)
    case 6:
      return [3];      // A B C | D E F
    case 7:
      return [3, 5];   // Ví dụ: A B C | D | E F G
    case 8:
      return [2, 6];   // A B | C D E F | G H
    case 9:
      return [3, 6];   // A B C | D E F | G H I
    case 10:
      return [3, 7];   // A B C | D E F G | H I J (Boeing 777 phổ biến)
    default:
      // Tốt nhất sau này lưu aisles trực tiếp để linh hoạt hơn (ví dụ: trong SeatLayout chẳng hạn)
      return [];
  }
};

/**
 * Map FlightSeat.status -> FE status
 */
const mapSeatStatus = (flightSeat, now) => {
  // if no FlightSeat doc (shouldn't happen if seeded), treat as unavailable
  if (!flightSeat) return "BOOKED";

  const st = String(flightSeat.status || "").toLowerCase();

  if (st === "available") return "AVAILABLE";
  if (st === "booked") return "BOOKED";

  // HELD: if expired, treat as AVAILABLE (cleanup may run later)
  if (st === "held") {
    if (flightSeat.blockedUntil && new Date(flightSeat.blockedUntil) <= now) return "AVAILABLE";
    return "HELD";
  }

  return "BOOKED";
}

module.exports = { computeAisles, mapSeatStatus }