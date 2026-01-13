const authRoutes = require('./auth.route');
const airlineRoutes = require('./airline.route');
const flightRoutes = require('./flight.route');

module.exports = (app) => {
  // Version api
  const version = '/api/v1/admin';
  
  app.use(version + '/auth', authRoutes);

  app.use(version + '/airlines', airlineRoutes);

  app.use(version + '/flights', flightRoutes);
}