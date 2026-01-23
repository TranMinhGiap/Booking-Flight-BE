const authRoutes = require('./auth.route');
const airportRoutes = require('./airport.route');
const seatClassRoutes = require('./seatClass.route');
const flightScheduleRoutes = require('./flightSchedule.route');
const bookingSessionRoutes = require('./bookingSession.route');

module.exports = (app) => {
  // Version api
  const version = '/api/v1';
  
  app.use(version + '/auth', authRoutes);

  app.use(version + '/airports', airportRoutes);

  app.use(version + '/seat-classes', seatClassRoutes);

  app.use(version + '/flight-schedules', flightScheduleRoutes);

  app.use(version + '/booking-sessions', bookingSessionRoutes);
}