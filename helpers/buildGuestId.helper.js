module.exports.buildGuestId = () => {
  // guestId không cần bí mật, chỉ để group session theo “thiết bị”
  return `g_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}