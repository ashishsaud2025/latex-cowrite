'use strict';

// Thin entry point that keeps `node server.js` / `npm start` working while the
// real implementation lives under src/server/index.js.
const { app, server, start, normalizeProjectSettings, SERVER_INSTANCE_ID } = require('./src/server/index');

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  normalizeProjectSettings,
  SERVER_INSTANCE_ID,
};
