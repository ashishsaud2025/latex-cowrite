'use strict';

const express = require('express');
const { SERVER_INSTANCE_ID } = require('../constants');
const { checkTectonicAvailable } = require('../compile');

const router = express.Router();

// GET /api/tectonic-status
router.get('/tectonic-status', (req, res) => {
  res.json(checkTectonicAvailable());
});

// Lets a client check over plain HTTP whether it's still talking to the same
// server process, before allowing an auto WebSocket reconnect (see public/js).
router.get('/server-instance-id', (req, res) => {
  res.json({ id: SERVER_INSTANCE_ID });
});

module.exports = router;
