'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const {
  PORT,
  SERVER_INSTANCE_ID,
} = require('./constants');
const { checkTectonicAvailable } = require('./compile');
const { createCollaborationServer, handleUpgrade } = require('./collaboration');
const { ensureProjectsRoot } = require('./bootstrap');
const projectsRouter = require('./routes/projects');
const settingsRouter = require('./routes/settings');
const compileRouter = require('./routes/compile');
const miscRouter = require('./routes/misc');

const app = express();
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
const server = http.createServer(app);

// Wire the WebSocket collaboration layer onto HTTP upgrade requests.
const collaborationServer = createCollaborationServer();
server.on('upgrade', (request, socket, head) => {
  handleUpgrade(collaborationServer, server, request, socket, head);
});

// REST API routes.
app.use('/api/projects', projectsRouter);
app.use('/api/projects', settingsRouter);
app.use('/api/projects', compileRouter);
app.use('/api', miscRouter);

// tectonic availability warning at startup.
const startupCheck = checkTectonicAvailable();
if (!startupCheck.available) {
  console.warn('=================================================================');
  console.warn(' WARNING: `tectonic` was not found on PATH.');
  console.warn(' Install it before compiling will work: https://tectonic-typesetting.github.io/');
  console.warn('=================================================================');
} else {
  console.log(`tectonic found: ${startupCheck.detail}`);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

function start() {
  return ensureProjectsRoot()
    .catch((err) => {
      console.error('Failed to set up projects/ directory:', err.message);
    })
    .finally(() => {
      server.listen(PORT, () => {
        console.log(`latex-cowrite listening on http://localhost:${PORT}`);
      });
    });
}

module.exports = {
  app,
  server,
  start,
  normalizeProjectSettings: require('./settings').normalizeProjectSettings,
  SERVER_INSTANCE_ID,
};
