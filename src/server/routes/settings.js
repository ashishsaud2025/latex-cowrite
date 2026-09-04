'use strict';

const express = require('express');
const { docs: yDocs } = require('y-websocket/bin/utils');
const { projectRootFor, projectExists } = require('../projects');
const { normalizeProjectSettings, readProjectSettings, writeProjectSettings } = require('../settings');
const { settingsRoomKeyFor } = require('../collaboration');

const router = express.Router();

async function requireProjectRoot(req, res) {
  const root = projectRootFor(req.params.project);
  if (!root || !(await projectExists(root))) {
    res.status(404).json({ error: 'Project not found.' });
    return null;
  }
  return root;
}

// GET /api/projects/:project/settings
router.get('/:project/settings', async (req, res) => {
  const root = await requireProjectRoot(req, res);
  if (!root) return;
  const settings = await readProjectSettings(req.params.project);
  res.json({ settings });
});

// PATCH /api/projects/:project/settings
router.patch('/:project/settings', async (req, res) => {
  const projectName = req.params.project;
  const root = await requireProjectRoot(req, res);
  if (!root) return;

  const settingsDoc = yDocs.get(settingsRoomKeyFor(projectName));
  if (settingsDoc) {
    const settingsMap = settingsDoc.getMap('settings');
    const nextSettings = normalizeProjectSettings(req.body || {});
    settingsDoc.transact(() => {
      for (const [key, value] of Object.entries(nextSettings)) {
        settingsMap.set(key, value);
      }
      for (const key of Array.from(settingsMap.keys())) {
        if (!(key in nextSettings)) {
          settingsMap.delete(key);
        }
      }
    });
    const settings = normalizeProjectSettings(Object.fromEntries(settingsMap.entries()));
    return res.json({ settings });
  }

  const settings = await writeProjectSettings(projectName, req.body || {});
  res.json({ settings });
});

module.exports = router;
