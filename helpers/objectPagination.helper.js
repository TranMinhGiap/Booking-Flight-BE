module.exports.objectPagination = (query, totalRecord) => {
  const defaultLimit = 15;

  const rawLimit = Number.parseInt(query.limit, 10);
  const rawPage  = Number.parseInt(query.page, 10);

  let limit;
  if (rawLimit === 0) {
    // lấy hết: để limit = totalRecord nếu >0, nếu 0 thì fallback defaultLimit
    limit = totalRecord > 0 ? totalRecord : defaultLimit;
  } else {
    limit = Number.isFinite(rawLimit) ? rawLimit : defaultLimit;
    limit = Math.max(1, Math.min(limit, 100));
  }

  const totalPage = Math.max(1, Math.ceil(totalRecord / limit));
  let currPage = Number.isFinite(rawPage) ? rawPage : 1;
  currPage = Math.max(1, Math.min(currPage, totalPage));

  const skip = (currPage - 1) * limit;

  return {
    currPage,
    limit,
    skip,
    totalPage,
    totalRecord,
    page_next: currPage < totalPage ? currPage + 1 : null,
    page_prev: currPage > 1 ? currPage - 1 : null,
  };
};