const authRoutes = require('./auth.route');
const airlineRoutes = require('./airline.route');
const flightRoutes = require('./flight.route');
const airplaneRoutes = require('./airplane.route');
const seatLayout = require('./seatLayout.route');
const seatClass = require('./seatClass.route');

module.exports = (app) => {
  // Version api
  const version = '/api/v1/admin';
  
  app.use(version + '/auth', authRoutes);

  app.use(version + '/airlines', airlineRoutes);

  app.use(version + '/flights', flightRoutes);

  app.use(version + '/airplanes', airplaneRoutes);

  app.use(version + '/seat-layouts', seatLayout);

  app.use(version + '/seat-classes', seatClass);
}