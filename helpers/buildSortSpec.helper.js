module.exports.buildSortSpec = (sortKey) => {
  switch (sortKey) {
    case "dep_asc":
      return { departureTime: 1, _id: 1 };

    case "dep_desc":
      return { departureTime: -1, _id: 1 };

    case "arr_asc":
      return { arrivalTime: 1, _id: 1 };

    case "arr_desc":
      return { arrivalTime: -1, _id: 1 };

    case "price_asc":
      // totalAdult đã được $addFields trong baseCore
      // thêm departureTime để “ổn định” khi cùng giá
      return { totalAdult: 1, departureTime: 1, _id: 1 };

    case "price_desc":
      return { totalAdult: -1, departureTime: 1, _id: 1 };

    default:
      return { departureTime: 1, _id: 1 };
  }
}
