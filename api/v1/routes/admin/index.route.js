const authRoutes = require('./auth.route');

module.exports = (app) => {
  // Version api
  const version = '/api/v1/admin';
  
  app.use(version + '/auth', authRoutes);
}